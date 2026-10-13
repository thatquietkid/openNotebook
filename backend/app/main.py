import os
import shutil
import uuid
from typing import List, Optional, Dict, Any
from fastapi import FastAPI, UploadFile, File, Form, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .database import (
    init_db,
    create_notebook,
    list_notebooks,
    get_notebook,
    insert_source_and_chunks,
    list_sources,
    get_source_with_chunks,
    delete_source,
    vector_search,
    insert_message,
    list_messages,
    clear_messages,
    save_studio_artifact,
    list_studio_artifacts,
)
from .processor_client import process_file_with_go, embed_texts_with_go, check_go_service
from .llm_client import (
    generate_grounded_answer,
    generate_podcast_script,
    generate_study_guide,
    generate_briefing_doc,
    generate_faq,
    GROQ_API_KEY,
)

app = FastAPI(
    title="NotebookLM Advanced RAG Backend",
    description="Full-featured local RAG engine backed by SQLite3 and Go file processor",
    version="1.0.0"
)

# Enable CORS for frontend Vite / dev server
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

WORKSPACE_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DATA_DIR = os.path.join(WORKSPACE_ROOT, "data", "pdf")
FRONTEND_DIR = os.path.join(WORKSPACE_ROOT, "frontend")
UPLOAD_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)

# Startup Hook
@app.on_event("startup")
async def startup_event():
    init_db()
    # Check if any notebook exists, if not create default
    notebooks = list_notebooks()
    if not notebooks:
        default_nb = create_notebook(
            notebook_id="default-research",
            title="Transformer Research Notebook",
            description="Deep dive analysis into Attention Is All You Need and modern neural architectures"
        )
        # Check if attention.pdf exists in data/pdf and auto-import
        attention_path = os.path.join(DATA_DIR, "attention.pdf")
        if os.path.exists(attention_path):
            try:
                print(f"[Startup] Indexing sample document: {attention_path}")
                proc_res = await process_file_with_go(attention_path)
                source_id = "src_" + uuid.uuid4().hex[:10]
                insert_source_and_chunks(
                    source_id=source_id,
                    notebook_id=default_nb["id"],
                    filename="attention.pdf",
                    file_type=".pdf",
                    file_path=attention_path,
                    file_size=os.path.getsize(attention_path),
                    page_count=proc_res.get("total_pages", 15),
                    chunks=proc_res.get("chunks", []),
                    summary="Foundational research paper introducing the Transformer architecture based solely on attention mechanisms."
                )
                print(f"[Startup] Indexed {len(proc_res.get('chunks', []))} chunks from attention.pdf!")
            except Exception as e:
                print(f"[Startup] Error auto-indexing attention.pdf: {e}")

# Models
class CreateNotebookRequest(BaseModel):
    title: str
    description: Optional[str] = ""

class ChatRequest(BaseModel):
    query: str
    active_sources: Optional[List[str]] = None
    top_k: Optional[int] = 6

class StudioRequest(BaseModel):
    active_sources: Optional[List[str]] = None

class SaveNoteRequest(BaseModel):
    title: str
    content: str

# Health Check
@app.get("/api/health")
async def health_check():
    go_healthy = await check_go_service()
    return {
        "status": "healthy",
        "database": "sqlite3_ready",
        "go_processor": "http_active" if go_healthy else "cli_ready",
        "llm_provider": "groq_active" if bool(GROQ_API_KEY) else "groq_api_missing",
    }

# Notebook Endpoints
@app.get("/api/notebooks")
async def get_all_notebooks():
    return list_notebooks()

@app.post("/api/notebooks")
async def create_new_notebook(req: CreateNotebookRequest):
    nb_id = "nb_" + uuid.uuid4().hex[:10]
    return create_notebook(notebook_id=nb_id, title=req.title, description=req.description or "")

@app.get("/api/notebooks/{notebook_id}")
async def get_notebook_by_id(notebook_id: str):
    nb = get_notebook(notebook_id)
    if not nb:
        raise HTTPException(status_code=404, detail="Notebook not found")
    sources = list_sources(notebook_id)
    nb["sources"] = sources
    return nb

# Source Endpoints
@app.get("/api/notebooks/{notebook_id}/sources")
async def get_notebook_sources(notebook_id: str):
    return list_sources(notebook_id)

@app.post("/api/notebooks/{notebook_id}/sources/upload")
async def upload_source(
    notebook_id: str,
    file: UploadFile = File(...),
    chunk_size: int = Form(700),
    chunk_overlap: int = Form(150)
):
    nb = get_notebook(notebook_id)
    if not nb:
        raise HTTPException(status_code=404, detail="Notebook not found")

    file_ext = os.path.splitext(file.filename)[1].lower()
    temp_filename = f"{uuid.uuid4().hex}_{file.filename}"
    saved_path = os.path.join(UPLOAD_DIR, temp_filename)

    with open(saved_path, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)

    try:
        proc_res = await process_file_with_go(saved_path, chunk_size=chunk_size, chunk_overlap=chunk_overlap)
        source_id = "src_" + uuid.uuid4().hex[:10]
        result = insert_source_and_chunks(
            source_id=source_id,
            notebook_id=notebook_id,
            filename=file.filename,
            file_type=file_ext,
            file_path=saved_path,
            file_size=os.path.getsize(saved_path),
            page_count=proc_res.get("total_pages", 1),
            chunks=proc_res.get("chunks", []),
            summary=f"Uploaded source containing {proc_res.get('total_chunks', 0)} chunks across {proc_res.get('total_pages', 1)} pages."
        )
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to process source with Go: {str(e)}")

@app.post("/api/notebooks/{notebook_id}/sources/import-sample")
async def import_sample_source(notebook_id: str, sample_name: str = "attention.pdf"):
    nb = get_notebook(notebook_id)
    if not nb:
        raise HTTPException(status_code=404, detail="Notebook not found")

    target_path = os.path.join(DATA_DIR, sample_name)
    if not os.path.exists(target_path):
        raise HTTPException(status_code=404, detail=f"Sample {sample_name} not found in data/pdf")

    proc_res = await process_file_with_go(target_path)
    source_id = "src_" + uuid.uuid4().hex[:10]
    result = insert_source_and_chunks(
        source_id=source_id,
        notebook_id=notebook_id,
        filename=sample_name,
        file_type=os.path.splitext(sample_name)[1].lower(),
        file_path=target_path,
        file_size=os.path.getsize(target_path),
        page_count=proc_res.get("total_pages", 1),
        chunks=proc_res.get("chunks", []),
        summary=f"Standard reference document: {sample_name}"
    )
    return result

@app.get("/api/sources/{source_id}")
async def get_source_details(source_id: str):
    source = get_source_with_chunks(source_id)
    if not source:
        raise HTTPException(status_code=404, detail="Source not found")
    return source

@app.delete("/api/sources/{source_id}")
async def remove_source(source_id: str):
    delete_source(source_id)
    return {"status": "deleted", "source_id": source_id}

# Chat & RAG Endpoints
@app.get("/api/notebooks/{notebook_id}/messages")
async def get_chat_history(notebook_id: str):
    return list_messages(notebook_id)

@app.delete("/api/notebooks/{notebook_id}/messages")
async def reset_chat_history(notebook_id: str):
    clear_messages(notebook_id)
    return {"status": "cleared"}

@app.post("/api/notebooks/{notebook_id}/chat")
async def submit_query(notebook_id: str, req: ChatRequest):
    nb = get_notebook(notebook_id)
    if not nb:
        raise HTTPException(status_code=404, detail="Notebook not found")

    # 1. Embed user query using Go processor / embedder
    query_embeddings = await embed_texts_with_go([req.query])
    query_vec = query_embeddings[0] if query_embeddings else []

    # 2. Vector search in SQLite3 across selected sources
    retrieved_chunks = vector_search(
        notebook_id=notebook_id,
        query_vector=query_vec,
        active_source_ids=req.active_sources,
        top_k=req.top_k or 6
    )

    # 3. Retrieve recent conversation history
    history = list_messages(notebook_id)

    # 4. Generate grounded response with Groq LLM
    try:
        llm_response = await generate_grounded_answer(
            query=req.query,
            chunks=retrieved_chunks,
            conversation_history=history
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"LLM generation failed: {str(e)}")

    # 5. Persist user message and assistant answer
    user_msg_id = "msg_" + uuid.uuid4().hex[:10]
    assistant_msg_id = "msg_" + uuid.uuid4().hex[:10]

    insert_message(user_msg_id, notebook_id, "user", req.query)
    ai_msg = insert_message(
        assistant_msg_id,
        notebook_id,
        "assistant",
        llm_response["answer"],
        citations=llm_response["citations"]
    )

    return {
        "message": ai_msg,
        "retrieved_chunks": retrieved_chunks
    }

# Studio Endpoints (NotebookLM Signature Features)
@app.post("/api/notebooks/{notebook_id}/studio/podcast")
async def generate_audio_overview(notebook_id: str, req: StudioRequest):
    """Generates the signature NotebookLM Audio Overview (Host 1 & Host 2 discussion)"""
    sources = list_sources(notebook_id)
    if not sources:
        raise HTTPException(status_code=400, detail="No sources available. Upload a source first.")

    # Get sample chunks across the active sources
    all_chunks = vector_search(
        notebook_id=notebook_id,
        query_vector=[0.05] * 384,
        active_source_ids=req.active_sources,
        top_k=15
    )

    nb = get_notebook(notebook_id)
    podcast_data = await generate_podcast_script(all_chunks, nb["title"] if nb else "Research Document")

    artifact_id = "art_pod_" + uuid.uuid4().hex[:8]
    saved = save_studio_artifact(artifact_id, notebook_id, "podcast", podcast_data["episode_title"], podcast_data)
    return saved

@app.post("/api/notebooks/{notebook_id}/studio/study-guide")
async def create_study_guide_endpoint(notebook_id: str, req: StudioRequest):
    nb = get_notebook(notebook_id)
    chunks = vector_search(notebook_id, [0.05]*384, req.active_sources, top_k=12)
    res = await generate_study_guide(chunks, nb["title"] if nb else "Notebook")
    artifact_id = "art_sg_" + uuid.uuid4().hex[:8]
    return save_studio_artifact(artifact_id, notebook_id, "study_guide", res["title"], res["content"])

@app.post("/api/notebooks/{notebook_id}/studio/briefing-doc")
async def create_briefing_doc_endpoint(notebook_id: str, req: StudioRequest):
    nb = get_notebook(notebook_id)
    chunks = vector_search(notebook_id, [0.05]*384, req.active_sources, top_k=12)
    res = await generate_briefing_doc(chunks, nb["title"] if nb else "Notebook")
    artifact_id = "art_bd_" + uuid.uuid4().hex[:8]
    return save_studio_artifact(artifact_id, notebook_id, "briefing_doc", res["title"], res["content"])

@app.post("/api/notebooks/{notebook_id}/studio/faq")
async def create_faq_endpoint(notebook_id: str, req: StudioRequest):
    nb = get_notebook(notebook_id)
    chunks = vector_search(notebook_id, [0.05]*384, req.active_sources, top_k=12)
    res = await generate_faq(chunks, nb["title"] if nb else "Notebook")
    artifact_id = "art_faq_" + uuid.uuid4().hex[:8]
    return save_studio_artifact(artifact_id, notebook_id, "faq", res["title"], res["content"])

@app.get("/api/notebooks/{notebook_id}/studio/artifacts")
async def get_notebook_artifacts(notebook_id: str):
    return list_studio_artifacts(notebook_id)

@app.post("/api/notebooks/{notebook_id}/studio/notes")
async def save_custom_note(notebook_id: str, req: SaveNoteRequest):
    artifact_id = "art_note_" + uuid.uuid4().hex[:8]
    return save_studio_artifact(artifact_id, notebook_id, "note", req.title, req.content)

# Serve the frontend and API from one local origin.
app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
