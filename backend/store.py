import json
import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = Path(os.environ.get('PDF_CHAT_DATA', ROOT / 'data'))
DATA.mkdir(parents=True, exist_ok=True)
(DATA / 'pdfs').mkdir(exist_ok=True)
DEFAULTS = {
    'provider': 'ollama', 'ollama_url': 'http://localhost:11434',
    'lmstudio_url': 'http://localhost:1234/v1', 'chat_model': '',
    'embedding_provider': 'ollama', 'embedding_model': 'nomic-embed-text',
    'top_k': 4, 'max_tokens': 512,
}


@contextmanager
def db():
    connection = sqlite3.connect(DATA / 'app.sqlite', timeout=30)
    connection.row_factory = sqlite3.Row
    try:
        yield connection
        connection.commit()
    finally:
        connection.close()


def init():
    with db() as c:
        c.executescript('''
        CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS documents (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, size INTEGER, pages INTEGER DEFAULT 0,
          status TEXT, error TEXT DEFAULT '', fingerprint TEXT DEFAULT '', chunks INTEGER DEFAULT 0);
        CREATE TABLE IF NOT EXISTS conversations (
          id TEXT PRIMARY KEY, title TEXT, updated TEXT DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE IF NOT EXISTS messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT, role TEXT, content TEXT,
          sources TEXT DEFAULT '[]', created TEXT DEFAULT CURRENT_TIMESTAMP);
        ''')

        columns = {r[1] for r in c.execute('PRAGMA table_info(messages)')}
        if 'summary' not in columns:
            c.execute("ALTER TABLE messages ADD COLUMN summary TEXT DEFAULT 'null'")


def settings():
    with db() as c:
        row = c.execute('SELECT value FROM settings WHERE id=1').fetchone()
    return {**DEFAULTS, **(json.loads(row[0]) if row else {})}


def save_settings(value):
    with db() as c:
        c.execute('INSERT OR REPLACE INTO settings VALUES (1,?)', (json.dumps(value),))


init()
