# app.py — Sklepik Szkolny Backend
# Simple Flask backend for a school point-of-sale system.
# Single file: configuration, models, auth, all endpoints.

import os
import io
import json
import time
from collections import defaultdict
from datetime import datetime, timezone
from functools import wraps

from flask import Flask, request, jsonify, render_template, redirect, url_for, send_file, send_from_directory
from flask_sqlalchemy import SQLAlchemy
from flask_login import (
    LoginManager, UserMixin,
    login_user, logout_user, login_required, current_user,
)
from werkzeug.security import generate_password_hash, check_password_hash


# ============================================================
# RATE LIMITING (brute-force protection for /login)
# ============================================================

_login_attempts: dict = defaultdict(list)

def _check_login_rate(ip: str, limit: int = 10, window: int = 60) -> bool:
    """Returns False if the IP has exceeded the attempt limit within the time window."""
    now = time.time()
    _login_attempts[ip] = [t for t in _login_attempts[ip] if now - t < window]
    if len(_login_attempts[ip]) >= limit:
        return False
    _login_attempts[ip].append(now)
    return True


# ============================================================
# CONFIGURATION
# ============================================================

app = Flask(__name__)
app.config['SECRET_KEY'] = os.environ.get('SECRET_KEY', 'dev-secret-key-ZMIEN-NA-PRODUKCJI')

# Database: SQLite locally (absolute path next to app.py), or pass DATABASE_URL
# Using absolute path so gunicorn works regardless of the process CWD
_base_dir = os.path.dirname(os.path.abspath(__file__))
_data_dir  = os.path.join(_base_dir, 'data')
db_url = os.environ.get('DATABASE_URL', f'sqlite:///{_data_dir}/sklepik.db')
# Heroku/Railway provide URLs starting with "postgres://" — SQLAlchemy requires "postgresql://"
if db_url.startswith('postgres://'):
    db_url = db_url.replace('postgres://', 'postgresql://', 1)
app.config['SQLALCHEMY_DATABASE_URI'] = db_url
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False

db = SQLAlchemy(app)
login_manager = LoginManager(app)
login_manager.login_view = 'login_page'


# ============================================================
# DATABASE MODELS
# ============================================================

class User(UserMixin, db.Model):
    """System user — cashier or admin."""
    id                   = db.Column(db.Integer, primary_key=True)
    username             = db.Column(db.String(80), unique=True, nullable=False)
    password_hash        = db.Column(db.String(256), nullable=False)
    is_admin             = db.Column(db.Boolean, default=False)
    must_change_password = db.Column(db.Boolean, default=False, nullable=True)

    def set_password(self, password):
        self.password_hash = generate_password_hash(password)

    def check_password(self, password):
        return check_password_hash(self.password_hash, password)

    def to_dict(self):
        return {
            'id':                   self.id,
            'username':             self.username,
            'is_admin':             self.is_admin,
            'must_change_password': bool(self.must_change_password),
        }


class Product(db.Model):
    """Product in the shop."""
    id       = db.Column(db.Integer, primary_key=True)
    name     = db.Column(db.String(200), nullable=False)
    emoji    = db.Column(db.String(10), default='🛒')
    price    = db.Column(db.Integer, nullable=False)   # price in grosz (1 PLN = 100)
    stock    = db.Column(db.Integer, default=0)
    barcode  = db.Column(db.String(100), default='')
    category = db.Column(db.String(100), default='Inne')
    img      = db.Column(db.Text, default='')          # base64 JPEG, ~20-40 KB after JS resize

    def to_dict(self):
        return {
            'id':       self.id,
            'name':     self.name,
            'emoji':    self.emoji,
            'price':    self.price,
            'stock':    self.stock,
            'barcode':  self.barcode,
            'category': self.category,
            'img':      self.img,
        }


class Sale(db.Model):
    """Sales transaction."""
    id      = db.Column(db.Integer, primary_key=True)
    ts      = db.Column(db.BigInteger, nullable=False)  # ms timestamp (compatible with JS Date.now())
    date    = db.Column(db.String(10),  nullable=False)  # YYYY-MM-DD
    total   = db.Column(db.Integer,     nullable=False)  # total in grosz
    paid    = db.Column(db.Integer,     nullable=False)  # amount paid in grosz
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=True)
    items   = db.relationship('SaleItem', backref='sale', cascade='all, delete-orphan')

    def to_dict(self):
        return {
            'id':    self.id,
            'ts':    self.ts,
            'date':  self.date,
            'total': self.total,
            'paid':  self.paid,
            'items': [i.to_dict() for i in self.items],
        }


class SaleItem(db.Model):
    """Line item in a transaction (product snapshot — name/price frozen at time of sale)."""
    id         = db.Column(db.Integer, primary_key=True)
    sale_id    = db.Column(db.Integer, db.ForeignKey('sale.id'), nullable=False)
    product_id = db.Column(db.Integer, nullable=True)  # NULL if the product has been deleted
    name       = db.Column(db.String(200), nullable=False)
    emoji      = db.Column(db.String(10),  default='🛒')
    qty        = db.Column(db.Integer,     nullable=False)
    price      = db.Column(db.Integer,     nullable=False)  # unit price in grosz

    def to_dict(self):
        return {
            'id':         self.product_id,   # 'id' field for frontend compatibility
            'product_id': self.product_id,
            'name':       self.name,
            'emoji':      self.emoji,
            'qty':        self.qty,
            'price':      self.price,
        }


class AuditLog(db.Model):
    """Audit log — critical admin actions and logins."""
    id       = db.Column(db.Integer, primary_key=True)
    ts       = db.Column(db.BigInteger, nullable=False)
    user_id  = db.Column(db.Integer, nullable=True)
    username = db.Column(db.String(80), nullable=True)   # snapshot — user may be deleted later
    action   = db.Column(db.String(100), nullable=False)
    detail   = db.Column(db.String(500), default='')

    def to_dict(self):
        return {
            'ts':       self.ts,
            'username': self.username or '?',
            'action':   self.action,
            'detail':   self.detail,
        }


@login_manager.user_loader
def load_user(user_id):
    return db.session.get(User, int(user_id))


# ============================================================
# HELPER DECORATORS
# ============================================================

def admin_required(f):
    """Endpoint accessible to admins only."""
    @wraps(f)
    def decorated(*args, **kwargs):
        if not current_user.is_authenticated or not current_user.is_admin:
            return jsonify({'error': 'Brak uprawnień admina'}), 403
        return f(*args, **kwargs)
    return decorated


def log_action(action: str, detail: str = '') -> None:
    """Writes an audit log entry to the current DB session. Caller is responsible for commit."""
    now = datetime.now(timezone.utc)
    uname = current_user.username if current_user.is_authenticated else None
    uid   = current_user.id       if current_user.is_authenticated else None
    db.session.add(AuditLog(
        ts       = int(now.timestamp() * 1000),
        user_id  = uid,
        username = uname,
        action   = action,
        detail   = str(detail)[:500],
    ))


# ============================================================
# AUTH — login / logout
# ============================================================

@app.route('/')
def index():
    if current_user.is_authenticated:
        return redirect(url_for('app_page'))
    return redirect(url_for('login_page'))


@app.route('/login', methods=['GET', 'POST'])
def login_page():
    if current_user.is_authenticated:
        return redirect(url_for('app_page'))

    if request.method == 'GET':
        return render_template('login.html')

    # Accepts both JSON (fetch from JS) and regular form POST
    data = request.get_json(silent=True) or request.form
    username = data.get('username', '').strip()
    password = data.get('password', '')

    # Rate limiting — max 10 login attempts per minute per IP
    ip = request.headers.get('X-Forwarded-For', request.remote_addr or '').split(',')[0].strip()
    if not _check_login_rate(ip):
        if request.is_json:
            return jsonify({'error': 'Za dużo prób logowania. Poczekaj minutę i spróbuj ponownie.'}), 429
        return render_template('login.html', error='Za dużo prób logowania. Poczekaj minutę i spróbuj ponownie.')

    user = User.query.filter_by(username=username).first()
    if user and user.check_password(password):
        login_user(user, remember=True)
        log_action('LOGIN', f'Logowanie: {user.username}')
        db.session.commit()
        if request.is_json:
            return jsonify({'ok': True, 'user': user.to_dict()})
        return redirect(url_for('app_page'))

    if request.is_json:
        return jsonify({'error': 'Błędna nazwa użytkownika lub hasło'}), 401
    return render_template('login.html', error='Błędna nazwa użytkownika lub hasło')


@app.route('/logout')
@login_required
def logout():
    logout_user()
    return redirect(url_for('login_page'))


@app.route('/app')
@login_required
def app_page():
    return render_template('index.html')


@app.route('/api/me')
@login_required
def api_me():
    """Called by the frontend on startup to verify the session is active."""
    return jsonify(current_user.to_dict())


@app.route('/api/ping', methods=['GET'])
def api_ping():
    """Lightweight connectivity check endpoint — no auth required."""
    return jsonify({'ok': True})


@app.route('/sw.js')
def service_worker():
    """SW served from / — Service-Worker-Allowed extends scope to the entire application."""
    response = send_from_directory('static', 'sw.js')
    response.headers['Service-Worker-Allowed'] = '/'
    response.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
    return response


@app.route('/manifest.json')
def manifest():
    """PWA manifest served from root."""
    return send_from_directory('static', 'manifest.json')


# ============================================================
# PRODUCTS
# ============================================================

@app.route('/api/products', methods=['GET'])
@login_required
def get_products():
    products = Product.query.order_by(Product.id).all()
    return jsonify([p.to_dict() for p in products])


@app.route('/api/products', methods=['POST'])
@login_required
@admin_required
def add_product():
    d = request.get_json()
    p = Product(
        name     = d['name'],
        emoji    = d.get('emoji', '🛒'),
        price    = int(d['price']),
        stock    = int(d.get('stock', 0)),
        barcode  = d.get('barcode', ''),
        category = d.get('category', 'Inne'),
        img      = d.get('img', ''),
    )
    db.session.add(p)
    log_action('PRODUCT_ADD', f'Dodano produkt: {p.name}, cena: {p.price} gr')
    db.session.commit()
    return jsonify(p.to_dict()), 201


@app.route('/api/products/<int:pid>', methods=['PUT'])
@login_required
@admin_required
def update_product(pid):
    p = db.session.get(Product, pid)
    if not p:
        return jsonify({'error': 'Nie znaleziono produktu'}), 404
    d = request.get_json()
    p.name     = d.get('name',     p.name)
    p.emoji    = d.get('emoji',    p.emoji)
    p.price    = int(d.get('price',    p.price))
    p.stock    = int(d.get('stock',    p.stock))
    p.barcode  = d.get('barcode',  p.barcode)
    p.category = d.get('category', p.category)
    p.img      = d.get('img',      p.img)
    log_action('PRODUCT_EDIT', f'Edytowano produkt: {p.name} (id={pid})')
    db.session.commit()
    return jsonify(p.to_dict())


@app.route('/api/products/<int:pid>', methods=['DELETE'])
@login_required
@admin_required
def delete_product(pid):
    p = db.session.get(Product, pid)
    if not p:
        return jsonify({'error': 'Nie znaleziono produktu'}), 404
    log_action('PRODUCT_DELETE', f'Usunięto produkt: {p.name} (id={pid}, cena={p.price} gr, stan={p.stock})')
    db.session.delete(p)
    db.session.commit()
    return jsonify({'ok': True})


@app.route('/api/products/<int:pid>/restock', methods=['POST'])
@login_required
@admin_required
def restock_product(pid):
    p = db.session.get(Product, pid)
    if not p:
        return jsonify({'error': 'Nie znaleziono produktu'}), 404
    d = request.get_json()
    qty = int(d.get('qty', 0))
    if qty <= 0:
        return jsonify({'error': 'Ilość musi być większa niż 0'}), 400
    p.stock += qty
    db.session.commit()
    return jsonify(p.to_dict())


# ============================================================
# SALES
# ============================================================

@app.route('/api/sales', methods=['GET'])
@login_required
def get_sales():
    date      = request.args.get('date')
    date_from = request.args.get('date_from')
    date_to   = request.args.get('date_to')
    query = Sale.query
    if date:
        query = query.filter_by(date=date)
    elif date_from or date_to:
        if date_from:
            query = query.filter(Sale.date >= date_from)
        if date_to:
            query = query.filter(Sale.date <= date_to)
    sales = query.order_by(Sale.ts.desc()).all()
    return jsonify([s.to_dict() for s in sales])


@app.route('/api/sales', methods=['POST'])
@login_required
def create_sale():
    """
    Commit a sale. Checks stock atomically (with_for_update)
    so two tablets cannot sell the same item simultaneously.
    """
    d          = request.get_json()
    cart_items = d.get('items', [])   # [{id, qty}, ...]
    paid       = int(d.get('paid', 0))

    if not cart_items:
        return jsonify({'error': 'Pusty koszyk'}), 400

    # Fetch products with row-level lock (blocks concurrent transactions)
    products_to_update = []
    sale_items_data    = []
    total              = 0

    for item in cart_items:
        p = Product.query.with_for_update().filter_by(id=item['id']).first()
        if not p:
            return jsonify({'error': f'Produkt {item["id"]} nie istnieje'}), 400
        qty = int(item['qty'])
        if p.stock < qty:
            db.session.rollback()
            return jsonify({'error': f'Brak wystarczającego stanu dla „{p.name}" (dostępne: {p.stock})'}), 400

        products_to_update.append((p, qty))
        sale_items_data.append({
            'product_id': p.id,
            'name':       p.name,
            'emoji':      p.emoji,
            'qty':        qty,
            'price':      p.price,
        })
        total += p.price * qty

    if paid > 0 and paid < total:
        db.session.rollback()
        return jsonify({'error': 'Za mało gotówki'}), 400

    # All good — persist transaction and decrement stock
    now = datetime.now(timezone.utc)
    sale = Sale(
        ts      = int(now.timestamp() * 1000),
        date    = now.strftime('%Y-%m-%d'),
        total   = total,
        paid    = paid if paid > 0 else total,
        user_id = current_user.id,
    )
    db.session.add(sale)

    for p, qty in products_to_update:
        p.stock -= qty

    db.session.flush()  # sale.id is available after flush()

    for item_data in sale_items_data:
        db.session.add(SaleItem(sale_id=sale.id, **item_data))

    db.session.commit()
    return jsonify(sale.to_dict()), 201


# ============================================================
# BACKUP — export and import
# ============================================================

@app.route('/api/export', methods=['GET'])
@login_required
@admin_required
def export_backup():
    """Download full backup as a JSON file. Format compatible with the original static app."""
    backup = {
        'version':    2,
        'exportedAt': datetime.now(timezone.utc).isoformat(),
        'products':   [p.to_dict() for p in Product.query.all()],
        'sales':      [s.to_dict() for s in Sale.query.all()],
    }
    filename  = f"sklepik_backup_{datetime.now().strftime('%Y-%m-%d')}.json"
    json_data = json.dumps(backup, ensure_ascii=False, indent=2).encode('utf-8')
    return send_file(
        io.BytesIO(json_data),
        mimetype='application/json',
        as_attachment=True,
        download_name=filename,
    )


@app.route('/api/export/products', methods=['GET'])
@login_required
@admin_required
def export_products():
    """Download products only (without sales history)."""
    backup = {
        'version':    2,
        'exportedAt': datetime.now(timezone.utc).isoformat(),
        'products':   [p.to_dict() for p in Product.query.all()],
        'sales':      [],
    }
    filename  = f"sklepik_produkty_{datetime.now().strftime('%Y-%m-%d')}.json"
    json_data = json.dumps(backup, ensure_ascii=False, indent=2).encode('utf-8')
    return send_file(
        io.BytesIO(json_data),
        mimetype='application/json',
        as_attachment=True,
        download_name=filename,
    )


@app.route('/api/import', methods=['POST'])
@login_required
@admin_required
def import_backup():
    """
    Upload backup — overwrites products, optionally sales too.
    By default, sales history is NOT cleared — requires _import_sales=true flag.
    Accepts JSON body or multipart file upload.
    """
    if request.is_json:
        data = request.get_json()
    else:
        file = request.files.get('file')
        if not file:
            return jsonify({'error': 'Brak pliku'}), 400
        try:
            data = json.loads(file.read().decode('utf-8'))
        except json.JSONDecodeError:
            return jsonify({'error': 'Nieprawidłowy plik JSON'}), 400

    products_data = data.get('products', [])
    sales_data    = data.get('sales', [])
    import_sales  = bool(data.get('_import_sales', False))

    # Validation: backup must have a non-empty product list
    if not isinstance(products_data, list) or len(products_data) == 0:
        return jsonify({'error': 'Backup nie zawiera produktów — import anulowany dla bezpieczeństwa'}), 400

    # Validate that each product has the required fields
    for i, p in enumerate(products_data):
        if not isinstance(p, dict) or not p.get('name') or p.get('price') is None:
            return jsonify({'error': f'Produkt #{i+1} ma nieprawidłowy format (brak name/price)'}), 400

    # Replace products (always)
    Product.query.delete()
    db.session.flush()

    for p_data in products_data:
        db.session.add(Product(
            id       = p_data.get('id'),
            name     = p_data['name'],
            emoji    = p_data.get('emoji', '🛒'),
            price    = int(p_data['price']),
            stock    = int(p_data.get('stock', 0)),
            barcode  = p_data.get('barcode', ''),
            category = p_data.get('category', 'Inne'),
            img      = p_data.get('img', ''),
        ))

    # Sales history — only if the admin explicitly requested it
    if import_sales:
        SaleItem.query.delete()
        Sale.query.delete()
        db.session.flush()

        for s_data in sales_data:
            sale = Sale(
                id      = s_data.get('id'),
                ts      = s_data['ts'],
                date    = s_data['date'],
                total   = s_data['total'],
                paid    = s_data.get('paid', s_data['total']),
            )
            db.session.add(sale)
            db.session.flush()

            for i_data in s_data.get('items', []):
                db.session.add(SaleItem(
                    sale_id    = sale.id,
                    product_id = i_data.get('id') or i_data.get('product_id'),
                    name       = i_data['name'],
                    emoji      = i_data.get('emoji', '🛒'),
                    qty        = i_data['qty'],
                    price      = i_data['price'],
                ))

    log_action('IMPORT', f'Import backupu: {len(products_data)} produktów, '
                         f'sprzedaż: {"tak" if import_sales else "nie (zachowana)"}')
    db.session.commit()
    return jsonify({
        'ok':            True,
        'products':      Product.query.count(),
        'sales':         Sale.query.count(),
        'sales_replaced': import_sales,
    })


# ============================================================
# USERS (admin only)
# ============================================================

@app.route('/api/users', methods=['GET'])
@login_required
@admin_required
def get_users():
    return jsonify([u.to_dict() for u in User.query.all()])


@app.route('/api/users', methods=['POST'])
@login_required
@admin_required
def add_user():
    d        = request.get_json()
    username = d.get('username', '').strip()
    password = d.get('password', '')
    is_admin = bool(d.get('is_admin', False))

    if not username or not password:
        return jsonify({'error': 'Podaj nazwę użytkownika i hasło'}), 400
    if len(password) < 4:
        return jsonify({'error': 'Hasło musi mieć co najmniej 4 znaki'}), 400
    if User.query.filter_by(username=username).first():
        return jsonify({'error': 'Taka nazwa użytkownika już istnieje'}), 400

    u = User(username=username, is_admin=is_admin)
    u.set_password(password)
    db.session.add(u)
    log_action('USER_ADD', f'Dodano konto: {username}, admin={is_admin}')
    db.session.commit()
    return jsonify(u.to_dict()), 201


@app.route('/api/users/<int:uid>', methods=['DELETE'])
@login_required
@admin_required
def delete_user(uid):
    if uid == current_user.id:
        return jsonify({'error': 'Nie możesz usunąć własnego konta'}), 400
    u = db.session.get(User, uid)
    if not u:
        return jsonify({'error': 'Nie znaleziono użytkownika'}), 404
    log_action('USER_DELETE', f'Usunięto konto: {u.username} (id={uid}, admin={u.is_admin})')
    db.session.delete(u)
    db.session.commit()
    return jsonify({'ok': True})


@app.route('/api/users/<int:uid>/password', methods=['PUT'])
@login_required
def change_password(uid):
    # Admin can change anyone's password; regular user can only change their own
    if uid != current_user.id and not current_user.is_admin:
        return jsonify({'error': 'Brak uprawnień'}), 403
    d = request.get_json()
    password = d.get('password', '')
    if len(password) < 6:
        return jsonify({'error': 'Hasło musi mieć co najmniej 6 znaków'}), 400
    u = db.session.get(User, uid)
    if not u:
        return jsonify({'error': 'Nie znaleziono użytkownika'}), 404

    # When changing own password, require current password — unless it's a forced change (first login)
    if uid == current_user.id and not current_user.must_change_password:
        old_password = d.get('old_password', '')
        if not u.check_password(old_password):
            return jsonify({'error': 'Błędne stare hasło'}), 400

    u.set_password(password)
    u.must_change_password = False
    log_action('PASSWORD_CHANGE', f'Zmiana hasła dla: {u.username}')
    db.session.commit()
    return jsonify({'ok': True})


@app.route('/api/audit', methods=['GET'])
@login_required
@admin_required
def get_audit():
    """Last 200 audit log entries."""
    entries = AuditLog.query.order_by(AuditLog.ts.desc()).limit(200).all()
    return jsonify([e.to_dict() for e in entries])


# ============================================================
# DATABASE INITIALISATION
# ============================================================

def init_db():
    """Create tables and insert default data on first run."""
    os.makedirs(_data_dir, exist_ok=True)
    db.create_all()

    # Migration: add must_change_password column if missing (existing databases)
    with db.engine.connect() as conn:
        try:
            conn.execute(db.text('ALTER TABLE "user" ADD COLUMN must_change_password BOOLEAN DEFAULT 0'))
            conn.commit()
        except Exception:
            pass  # column already exists

    if User.query.count() == 0:
        admin = User(username='admin', is_admin=True, must_change_password=True)
        admin.set_password('admin')
        db.session.add(admin)
        print('✅ admin/admin account created — password change required on first login!')

    if Product.query.count() == 0:
        demo = [
            Product(name='Kanapka',    emoji='🥪', price=300, stock=20, category='Jedzenie'),
            Product(name='Woda 0,5l',  emoji='💧', price=200, stock=30, category='Napoje'),
            Product(name='Sok',        emoji='🧃', price=250, stock=25, category='Napoje'),
            Product(name='Baton',      emoji='🍫', price=200, stock=15, category='Słodycze'),
            Product(name='Drożdżówka', emoji='🥐', price=250, stock=10, category='Jedzenie'),
            Product(name='Chipsy',     emoji='🍟', price=350, stock=12, category='Przekąski'),
        ]
        db.session.add_all(demo)
        print('✅ Demo products added')

    db.session.commit()


with app.app_context():
    init_db()


# ============================================================
# ENTRYPOINT
# ============================================================

if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0', port=6060)
