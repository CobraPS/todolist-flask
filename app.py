from __future__ import annotations

import os
import re
import sqlite3
import calendar
from datetime import datetime, date, timedelta
from flask import Flask, jsonify, request, send_from_directory

APP_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(APP_DIR, "todos.sqlite3")

app = Flask(__name__, static_folder="static")

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")  # YYYY-MM-DD
ALLOWED_UNITS = {"daily", "weekly", "monthly"}
PRIORITY_MIN = 0  # Low
PRIORITY_MAX = 3  # Critical


def db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def table_columns(conn: sqlite3.Connection, table: str) -> set[str]:
    rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
    return {r["name"] for r in rows}


def now_utc_iso() -> str:
    return datetime.utcnow().isoformat(timespec="seconds") + "Z"


def parse_ymd(s: str) -> date:
    y, m, d = map(int, s.split("-"))
    return date(y, m, d)


def format_ymd(d: date) -> str:
    return d.strftime("%Y-%m-%d")


def add_months(d: date, months: int) -> date:
    y = d.year + (d.month - 1 + months) // 12
    m = (d.month - 1 + months) % 12 + 1
    last_day = calendar.monthrange(y, m)[1]
    day = min(d.day, last_day)
    return date(y, m, day)


def advance_date(due_ymd: str, unit: str, interval: int) -> str:
    d = parse_ymd(due_ymd)
    if unit == "daily":
        return format_ymd(d + timedelta(days=interval))
    if unit == "weekly":
        return format_ymd(d + timedelta(days=7 * interval))
    if unit == "monthly":
        return format_ymd(add_months(d, interval))
    raise ValueError("unsupported recurrence unit")


def normalize_due_date(value) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        v = value.strip()
        if v == "":
            return None
        if not DATE_RE.match(v):
            raise ValueError("due_date must be YYYY-MM-DD or empty")
        return v
    raise ValueError("due_date must be a string or null")


def normalize_parent_id(value) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool):
        raise ValueError("parent_id must be an integer or null")
    if isinstance(value, int):
        if value <= 0:
            raise ValueError("parent_id must be a positive integer")
        return value
    if isinstance(value, str):
        v = value.strip()
        if v == "":
            return None
        if not v.isdigit():
            raise ValueError("parent_id must be an integer or null")
        pid = int(v)
        if pid <= 0:
            raise ValueError("parent_id must be a positive integer")
        return pid
    raise ValueError("parent_id must be an integer or null")


def normalize_recurrence(unit, interval) -> tuple[str | None, int | None]:
    if unit is None:
        return None, None
    if isinstance(unit, str):
        u = unit.strip().lower()
        if u == "" or u == "none":
            return None, None
        if u not in ALLOWED_UNITS:
            raise ValueError("recurrence_unit must be one of: daily, weekly, monthly, none")
    else:
        raise ValueError("recurrence_unit must be a string or null")

    if interval is None or (isinstance(interval, str) and interval.strip() == ""):
        return u, 1
    if isinstance(interval, bool):
        raise ValueError("recurrence_interval must be a positive integer")
    if isinstance(interval, int):
        n = interval
    elif isinstance(interval, str) and interval.strip().isdigit():
        n = int(interval.strip())
    else:
        raise ValueError("recurrence_interval must be a positive integer")

    if n <= 0:
        raise ValueError("recurrence_interval must be a positive integer")

    return u, n


def normalize_priority(value) -> int:
    if value is None or value == "":
        return 1  # Normal default
    if isinstance(value, bool):
        raise ValueError("priority must be an integer 0..3")
    if isinstance(value, int):
        p = value
    elif isinstance(value, str) and value.strip().lstrip("-").isdigit():
        p = int(value.strip())
    else:
        raise ValueError("priority must be an integer 0..3")

    if p < PRIORITY_MIN or p > PRIORITY_MAX:
        raise ValueError("priority must be an integer 0..3")
    return p


def todo_exists(conn: sqlite3.Connection, todo_id: int, include_deleted: bool = False) -> bool:
    if include_deleted:
        row = conn.execute("SELECT 1 FROM todos WHERE id = ?", (todo_id,)).fetchone()
    else:
        row = conn.execute("SELECT 1 FROM todos WHERE id = ? AND deleted_at IS NULL", (todo_id,)).fetchone()
    return row is not None


def would_create_cycle(conn: sqlite3.Connection, todo_id: int, new_parent_id: int | None) -> bool:
    if new_parent_id is None:
        return False
    if new_parent_id == todo_id:
        return True

    cur = new_parent_id
    seen: set[int] = set()
    while cur is not None:
        if cur in seen:
            return True
        seen.add(cur)
        if cur == todo_id:
            return True
        row = conn.execute(
            "SELECT parent_id FROM todos WHERE id = ? AND deleted_at IS NULL",
            (cur,),
        ).fetchone()
        if row is None:
            return False
        cur = row["parent_id"]
    return False


def subtree_ids(conn: sqlite3.Connection, root_id: int, include_deleted: bool = True) -> list[int]:
    ids: list[int] = []
    stack = [root_id]
    while stack:
        nid = stack.pop()
        ids.append(nid)
        if include_deleted:
            child_rows = conn.execute("SELECT id FROM todos WHERE parent_id = ?", (nid,)).fetchall()
        else:
            child_rows = conn.execute(
                "SELECT id FROM todos WHERE parent_id = ? AND deleted_at IS NULL",
                (nid,),
            ).fetchall()
        stack.extend([r["id"] for r in child_rows])
    return ids


def soft_delete_subtree(conn: sqlite3.Connection, root_id: int) -> None:
    ids = subtree_ids(conn, root_id, include_deleted=True)
    ts = now_utc_iso()
    conn.execute(
        f"UPDATE todos SET deleted_at = ? WHERE id IN ({','.join(['?'] * len(ids))})",
        (ts, *ids),
    )


def restore_subtree(conn: sqlite3.Connection, root_id: int) -> None:
    ids = subtree_ids(conn, root_id, include_deleted=True)
    conn.execute(
        f"UPDATE todos SET deleted_at = NULL WHERE id IN ({','.join(['?'] * len(ids))})",
        tuple(ids),
    )


def hard_delete_subtree(conn: sqlite3.Connection, root_id: int) -> None:
    ids = subtree_ids(conn, root_id, include_deleted=True)
    conn.execute(
        f"DELETE FROM todos WHERE id IN ({','.join(['?'] * len(ids))})",
        tuple(ids),
    )


def clone_subtree_for_next_occurrence(
    conn: sqlite3.Connection,
    old_root_id: int,
    new_root_id: int,
    unit: str,
    interval: int,
) -> None:
    # Only clone live (non-deleted) rows
    rows = conn.execute(
        """
        SELECT id, text, due_date, parent_id, recurrence_unit, recurrence_interval, priority
        FROM todos
        WHERE deleted_at IS NULL AND id != ?
        """,
        (old_root_id,),
    ).fetchall()

    children: dict[int, list[sqlite3.Row]] = {}
    for r in rows:
        pid = r["parent_id"]
        if pid is None:
            continue
        children.setdefault(pid, []).append(r)

    now = now_utc_iso()
    stack = [(old_root_id, new_root_id)]
    while stack:
        old_parent, new_parent = stack.pop()
        for child in children.get(old_parent, []):
            old_due = child["due_date"]
            new_due = advance_date(old_due, unit, interval) if old_due else None

            cur = conn.execute(
                """
                INSERT INTO todos (text, done, created_at, due_date, parent_id, recurrence_unit, recurrence_interval, priority, deleted_at)
                VALUES (?, 0, ?, ?, ?, ?, ?, ?, NULL)
                """,
                (
                    child["text"],
                    now,
                    new_due,
                    new_parent,
                    child["recurrence_unit"],
                    child["recurrence_interval"],
                    child["priority"],
                ),
            )
            new_id = cur.lastrowid
            stack.append((child["id"], new_id))


def spawn_next_occurrence(conn: sqlite3.Connection, row: sqlite3.Row) -> None:
    unit = row["recurrence_unit"]
    interval = row["recurrence_interval"] or 1
    due = row["due_date"]
    if not unit or not due:
        return

    new_due = advance_date(due, unit, interval)
    now = now_utc_iso()

    cur = conn.execute(
        """
        INSERT INTO todos (text, done, created_at, due_date, parent_id, recurrence_unit, recurrence_interval, priority, deleted_at)
        VALUES (?, 0, ?, ?, ?, ?, ?, ?, NULL)
        """,
        (
            row["text"],
            now,
            new_due,
            row["parent_id"],
            unit,
            interval,
            row["priority"],
        ),
    )
    new_root_id = cur.lastrowid
    clone_subtree_for_next_occurrence(conn, row["id"], new_root_id, unit, interval)


def init_db() -> None:
    with db() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS todos (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                text TEXT NOT NULL,
                done INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL
            )
            """
        )

        cols = table_columns(conn, "todos")

        if "due_date" not in cols:
            conn.execute("ALTER TABLE todos ADD COLUMN due_date TEXT NULL")
        cols = table_columns(conn, "todos")
        if "parent_id" not in cols:
            conn.execute("ALTER TABLE todos ADD COLUMN parent_id INTEGER NULL")
        cols = table_columns(conn, "todos")
        if "recurrence_unit" not in cols:
            conn.execute("ALTER TABLE todos ADD COLUMN recurrence_unit TEXT NULL")
        if "recurrence_interval" not in cols:
            conn.execute("ALTER TABLE todos ADD COLUMN recurrence_interval INTEGER NULL")
        cols = table_columns(conn, "todos")
        if "priority" not in cols:
            conn.execute("ALTER TABLE todos ADD COLUMN priority INTEGER NOT NULL DEFAULT 1")
        cols = table_columns(conn, "todos")
        if "deleted_at" not in cols:
            conn.execute("ALTER TABLE todos ADD COLUMN deleted_at TEXT NULL")

        conn.execute("CREATE INDEX IF NOT EXISTS idx_todos_parent_id ON todos(parent_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_todos_due_date ON todos(due_date)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_todos_recur ON todos(recurrence_unit)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_todos_deleted ON todos(deleted_at)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_todos_priority ON todos(priority)")


@app.get("/")
def index():
    return send_from_directory("static", "index.html")


@app.get("/api/todos")
def list_todos():
    with db() as conn:
        rows = conn.execute(
            """
            SELECT id, text, done, created_at, due_date, parent_id,
                   recurrence_unit, recurrence_interval, priority
            FROM todos
            WHERE deleted_at IS NULL
            ORDER BY id DESC
            """
        ).fetchall()
    return jsonify([dict(r) for r in rows])


@app.post("/api/todos")
def create_todo():
    data = request.get_json(silent=True) or {}
    text = (data.get("text") or "").strip()
    if not text:
        return jsonify({"error": "text is required"}), 400

    try:
        due_date = normalize_due_date(data.get("due_date"))
        parent_id = normalize_parent_id(data.get("parent_id"))
        recurrence_unit, recurrence_interval = normalize_recurrence(
            data.get("recurrence_unit"),
            data.get("recurrence_interval"),
        )
        priority = normalize_priority(data.get("priority"))
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    if recurrence_unit and not due_date:
        return jsonify({"error": "recurring tasks require a due_date"}), 400

    created_at = now_utc_iso()

    with db() as conn:
        if parent_id is not None and not todo_exists(conn, parent_id, include_deleted=False):
            return jsonify({"error": "parent_id does not exist"}), 400

        cur = conn.execute(
            """
            INSERT INTO todos (text, done, created_at, due_date, parent_id, recurrence_unit, recurrence_interval, priority, deleted_at)
            VALUES (?, 0, ?, ?, ?, ?, ?, ?, NULL)
            """,
            (text, created_at, due_date, parent_id, recurrence_unit, recurrence_interval, priority),
        )
        todo_id = cur.lastrowid
        row = conn.execute(
            """
            SELECT id, text, done, created_at, due_date, parent_id, recurrence_unit, recurrence_interval, priority
            FROM todos WHERE id = ?
            """,
            (todo_id,),
        ).fetchone()

    return jsonify(dict(row)), 201


@app.patch("/api/todos/<int:todo_id>")
def update_todo(todo_id: int):
    data = request.get_json(silent=True) or {}

    with db() as conn:
        existing = conn.execute(
            """
            SELECT id, text, done, created_at, due_date, parent_id, recurrence_unit, recurrence_interval, priority, deleted_at
            FROM todos WHERE id = ? AND deleted_at IS NULL
            """,
            (todo_id,),
        ).fetchone()
        if existing is None:
            return jsonify({"error": "not found"}), 404

        prev_done = int(existing["done"])

        # Soft-restore (undo)
        if "deleted" in data and data["deleted"] is False:
            restore_subtree(conn, todo_id)
            row = conn.execute(
                """
                SELECT id, text, done, created_at, due_date, parent_id, recurrence_unit, recurrence_interval, priority
                FROM todos WHERE id = ? AND deleted_at IS NULL
                """,
                (todo_id,),
            ).fetchone()
            if row is None:
                return jsonify({"error": "restore failed"}), 500
            return jsonify(dict(row))

        fields: list[str] = []
        params: list[object] = []

        new_due = existing["due_date"]
        new_parent = existing["parent_id"]
        new_unit = existing["recurrence_unit"]
        new_interval = existing["recurrence_interval"]
        new_priority = existing["priority"]

        if "text" in data:
            t = (data.get("text") or "").strip()
            if not t:
                return jsonify({"error": "text cannot be empty"}), 400
            fields.append("text = ?")
            params.append(t)

        if "due_date" in data:
            try:
                dd = normalize_due_date(data.get("due_date"))
            except ValueError as e:
                return jsonify({"error": str(e)}), 400
            new_due = dd
            fields.append("due_date = ?")
            params.append(dd)

        if "parent_id" in data:
            try:
                pid = normalize_parent_id(data.get("parent_id"))
            except ValueError as e:
                return jsonify({"error": str(e)}), 400

            if pid is not None and not todo_exists(conn, pid, include_deleted=False):
                return jsonify({"error": "parent_id does not exist"}), 400
            if would_create_cycle(conn, todo_id, pid):
                return jsonify({"error": "parent_id would create a cycle"}), 400

            new_parent = pid
            fields.append("parent_id = ?")
            params.append(pid)

        if "recurrence_unit" in data or "recurrence_interval" in data:
            raw_unit = data.get("recurrence_unit", existing["recurrence_unit"])
            raw_int = data.get("recurrence_interval", existing["recurrence_interval"])
            try:
                u, n = normalize_recurrence(raw_unit, raw_int)
            except ValueError as e:
                return jsonify({"error": str(e)}), 400
            new_unit = u
            new_interval = n
            fields.append("recurrence_unit = ?")
            params.append(u)
            fields.append("recurrence_interval = ?")
            params.append(n)

        if "priority" in data:
            try:
                p = normalize_priority(data.get("priority"))
            except ValueError as e:
                return jsonify({"error": str(e)}), 400
            new_priority = p
            fields.append("priority = ?")
            params.append(p)

        if "done" in data:
            nd = 1 if bool(data["done"]) else 0
            fields.append("done = ?")
            params.append(nd)

        if new_unit and not new_due:
            return jsonify({"error": "recurring tasks require a due_date"}), 400

        if not fields:
            return jsonify({"error": "no fields to update"}), 400

        params.append(todo_id)
        conn.execute(f"UPDATE todos SET {', '.join(fields)} WHERE id = ?", tuple(params))

        row = conn.execute(
            """
            SELECT id, text, done, created_at, due_date, parent_id, recurrence_unit, recurrence_interval, priority
            FROM todos WHERE id = ? AND deleted_at IS NULL
            """,
            (todo_id,),
        ).fetchone()

        new_done = int(row["done"])
        if prev_done == 0 and new_done == 1 and row["recurrence_unit"]:
            spawn_next_occurrence(conn, row)

    return jsonify(dict(row))


@app.delete("/api/todos/<int:todo_id>")
def delete_todo(todo_id: int):
    with db() as conn:
        if not todo_exists(conn, todo_id, include_deleted=False):
            return jsonify({"error": "not found"}), 404
        soft_delete_subtree(conn, todo_id)
    return "", 204


def main():
    init_db()
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "5000"))
    app.run(host=host, port=port)


if __name__ == "__main__":
    main()

