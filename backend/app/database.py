import sqlite3
import json
import os
import math
from typing import List, Dict, Any, Optional
from datetime import datetime

DB_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "rag_notebooks.db")

def get_connection():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    conn = get_connection()
    cursor = conn.cursor()

    cursor.execute("""
    CREATE TABLE IF NOT EXISTS notebooks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    )
    """)

    cursor.execute("""
    CREATE TABLE IF NOT EXISTS sources (
        id TEXT PRIMARY KEY,
        notebook_id TEXT NOT NULL,
        filename TEXT NOT NULL,
        file_type TEXT NOT NULL,
        file_path TEXT,
        file_size INTEGER DEFAULT 0,
        page_count INTEGER DEFAULT 1,
        chunk_count INTEGER DEFAULT 0,
        char_count INTEGER DEFAULT 0,
        summary TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (notebook_id) REFERENCES notebooks (id) ON DELETE CASCADE
    )
    """)

    cursor.execute("""
    CREATE TABLE IF NOT EXISTS chunks (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        notebook_id TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        page_number INTEGER NOT NULL,
        content TEXT NOT NULL,
        token_count INTEGER DEFAULT 0,
        char_start INTEGER DEFAULT 0,
        char_end INTEGER DEFAULT 0,
        embedding_json TEXT NOT NULL,
        FOREIGN KEY (source_id) REFERENCES sources (id) ON DELETE CASCADE,
        FOREIGN KEY (notebook_id) REFERENCES notebooks (id) ON DELETE CASCADE
    )
    """)

    cursor.execute("""
    CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        notebook_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        citations_json TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (notebook_id) REFERENCES notebooks (id) ON DELETE CASCADE
    )
    """)

    cursor.execute("""
    CREATE TABLE IF NOT EXISTS studio_artifacts (
        id TEXT PRIMARY KEY,
        notebook_id TEXT NOT NULL,
        artifact_type TEXT NOT NULL,
        title TEXT NOT NULL,
        content_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (notebook_id) REFERENCES notebooks (id) ON DELETE CASCADE
    )
    """)

    cursor.execute("CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source_id)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_chunks_notebook ON chunks(notebook_id)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_messages_notebook ON messages(notebook_id)")

    conn.commit()
    conn.close()

# Notebook Operations
def create_notebook(notebook_id: str, title: str, description: str = "") -> Dict[str, Any]:
    now = datetime.utcnow().isoformat()
    conn = get_connection()
    c = conn.cursor()
    c.execute(
        "INSERT INTO notebooks (id, title, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        (notebook_id, title, description, now, now)
    )
    conn.commit()
    conn.close()
    return {"id": notebook_id, "title": title, "description": description, "created_at": now, "updated_at": now}

def list_notebooks() -> List[Dict[str, Any]]:
    conn = get_connection()
    c = conn.cursor()
    c.execute("""
        SELECT n.*, 
            COUNT(DISTINCT s.id) as source_count,
            COUNT(DISTINCT m.id) as message_count
        FROM notebooks n
        LEFT JOIN sources s ON n.id = s.notebook_id
        LEFT JOIN messages m ON n.id = m.notebook_id
        GROUP BY n.id
        ORDER BY n.updated_at DESC
    """)
    rows = [dict(r) for r in c.fetchall()]
    conn.close()
    return rows

def get_notebook(notebook_id: str) -> Optional[Dict[str, Any]]:
    conn = get_connection()
    c = conn.cursor()
    c.execute("SELECT * FROM notebooks WHERE id = ?", (notebook_id,))
    row = c.fetchone()
    conn.close()
    return dict(row) if row else None

# Source Operations
def insert_source_and_chunks(
    source_id: str,
    notebook_id: str,
    filename: str,
    file_type: str,
    file_path: str,
    file_size: int,
    page_count: int,
    chunks: List[Dict[str, Any]],
    summary: str = ""
) -> Dict[str, Any]:
    now = datetime.utcnow().isoformat()
    total_chars = sum(len(c.get("content", "")) for c in chunks)
    conn = get_connection()
    c = conn.cursor()

    c.execute("""
        INSERT INTO sources (id, notebook_id, filename, file_type, file_path, file_size, page_count, chunk_count, char_count, summary, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (source_id, notebook_id, filename, file_type, file_path, file_size, page_count, len(chunks), total_chars, summary, now))

    for chunk in chunks:
        chunk_id = f"{source_id}_chunk_{chunk.get('index', 0)}"
        emb_json = json.dumps(chunk.get("embedding", []))
        c.execute("""
            INSERT INTO chunks (id, source_id, notebook_id, chunk_index, page_number, content, token_count, char_start, char_end, embedding_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            chunk_id,
            source_id,
            notebook_id,
            chunk.get("index", 0),
            chunk.get("page_number", 1),
            chunk.get("content", ""),
            chunk.get("token_count", 0),
            chunk.get("char_start", 0),
            chunk.get("char_end", 0),
            emb_json
        ))

    # Update notebook timestamp
    c.execute("UPDATE notebooks SET updated_at = ? WHERE id = ?", (now, notebook_id))
    conn.commit()
    conn.close()

    return {
        "id": source_id,
        "notebook_id": notebook_id,
        "filename": filename,
        "file_type": file_type,
        "file_size": file_size,
        "page_count": page_count,
        "chunk_count": len(chunks),
        "created_at": now
    }

def list_sources(notebook_id: str) -> List[Dict[str, Any]]:
    conn = get_connection()
    c = conn.cursor()
    c.execute("SELECT * FROM sources WHERE notebook_id = ? ORDER BY created_at ASC", (notebook_id,))
    rows = [dict(r) for r in c.fetchall()]
    conn.close()
    return rows

def get_source_with_chunks(source_id: str) -> Optional[Dict[str, Any]]:
    conn = get_connection()
    c = conn.cursor()
    c.execute("SELECT * FROM sources WHERE id = ?", (source_id,))
    source_row = c.fetchone()
    if not source_row:
        conn.close()
        return None
    source = dict(source_row)

    c.execute("SELECT id, chunk_index, page_number, content, token_count, char_start, char_end FROM chunks WHERE source_id = ? ORDER BY chunk_index ASC", (source_id,))
    source["chunks"] = [dict(r) for r in c.fetchall()]
    conn.close()
    return source

def delete_source(source_id: str):
    conn = get_connection()
    c = conn.cursor()
    c.execute("DELETE FROM chunks WHERE source_id = ?", (source_id,))
    c.execute("DELETE FROM sources WHERE id = ?", (source_id,))
    conn.commit()
    conn.close()

# Vector Similarity Search in SQLite
def vector_search(
    notebook_id: str,
    query_vector: List[float],
    active_source_ids: Optional[List[str]] = None,
    top_k: int = 6
) -> List[Dict[str, Any]]:
    """
    Computes cosine similarity between query_vector and stored chunks for given notebook/sources.
    Cosine similarity is dot product when vectors are normalized.
    """
    conn = get_connection()
    c = conn.cursor()

    if active_source_ids is not None and not active_source_ids:
        conn.close()
        return []

    if active_source_ids is not None:
        placeholders = ",".join("?" for _ in active_source_ids)
        query = f"""
            SELECT c.id, c.source_id, c.notebook_id, c.chunk_index, c.page_number, c.content, c.token_count, c.embedding_json,
                   s.filename as source_name, s.file_type
            FROM chunks c
            JOIN sources s ON c.source_id = s.id
            WHERE c.notebook_id = ? AND c.source_id IN ({placeholders})
        """
        params = [notebook_id] + active_source_ids
    else:
        query = """
            SELECT c.id, c.source_id, c.notebook_id, c.chunk_index, c.page_number, c.content, c.token_count, c.embedding_json,
                   s.filename as source_name, s.file_type
            FROM chunks c
            JOIN sources s ON c.source_id = s.id
            WHERE c.notebook_id = ?
        """
        params = [notebook_id]

    c.execute(query, params)
    rows = c.fetchall()
    conn.close()

    if not rows:
        return []

    scored_chunks = []
    q_len = len(query_vector)

    for row in rows:
        emb = json.loads(row["embedding_json"])
        # Fast dot product
        score = 0.0
        limit = min(q_len, len(emb))
        for i in range(limit):
            score += query_vector[i] * emb[i]

        chunk_dict = {
            "id": row["id"],
            "source_id": row["source_id"],
            "source_name": row["source_name"],
            "chunk_index": row["chunk_index"],
            "page_number": row["page_number"],
            "content": row["content"],
            "token_count": row["token_count"],
            "score": float(score)
        }
        scored_chunks.append(chunk_dict)

    scored_chunks.sort(key=lambda x: x["score"], reverse=True)
    return scored_chunks[:top_k]

# Messages Operations
def insert_message(message_id: str, notebook_id: str, role: str, content: str, citations: Optional[List[Dict[str, Any]]] = None) -> Dict[str, Any]:
    now = datetime.utcnow().isoformat()
    cit_json = json.dumps(citations or [])
    conn = get_connection()
    c = conn.cursor()
    c.execute(
        "INSERT INTO messages (id, notebook_id, role, content, citations_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        (message_id, notebook_id, role, content, cit_json, now)
    )
    c.execute("UPDATE notebooks SET updated_at = ? WHERE id = ?", (now, notebook_id))
    conn.commit()
    conn.close()
    return {
        "id": message_id,
        "notebook_id": notebook_id,
        "role": role,
        "content": content,
        "citations": citations or [],
        "created_at": now
    }

def list_messages(notebook_id: str) -> List[Dict[str, Any]]:
    conn = get_connection()
    c = conn.cursor()
    c.execute("SELECT * FROM messages WHERE notebook_id = ? ORDER BY created_at ASC", (notebook_id,))
    rows = c.fetchall()
    conn.close()
    result = []
    for r in rows:
        d = dict(r)
        d["citations"] = json.loads(d.get("citations_json") or "[]")
        result.append(d)
    return result

def clear_messages(notebook_id: str):
    conn = get_connection()
    c = conn.cursor()
    c.execute("DELETE FROM messages WHERE notebook_id = ?", (notebook_id,))
    conn.commit()
    conn.close()

# Studio Artifacts Operations
def save_studio_artifact(artifact_id: str, notebook_id: str, artifact_type: str, title: str, content: Any) -> Dict[str, Any]:
    now = datetime.utcnow().isoformat()
    conn = get_connection()
    c = conn.cursor()
    c.execute(
        "INSERT OR REPLACE INTO studio_artifacts (id, notebook_id, artifact_type, title, content_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        (artifact_id, notebook_id, artifact_type, title, json.dumps(content), now)
    )
    conn.commit()
    conn.close()
    return {
        "id": artifact_id,
        "notebook_id": notebook_id,
        "artifact_type": artifact_type,
        "title": title,
        "content": content,
        "created_at": now
    }

def list_studio_artifacts(notebook_id: str) -> List[Dict[str, Any]]:
    conn = get_connection()
    c = conn.cursor()
    c.execute("SELECT * FROM studio_artifacts WHERE notebook_id = ? ORDER BY created_at DESC", (notebook_id,))
    rows = c.fetchall()
    conn.close()
    result = []
    for r in rows:
        d = dict(r)
        d["content"] = json.loads(d.get("content_json") or "{}")
        result.append(d)
    return result
