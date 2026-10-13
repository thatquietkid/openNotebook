import os
import sys
import json
import httpx
import subprocess
from typing import Dict, Any, List, Optional
import math

GO_PROCESSOR_URL = os.getenv("GO_PROCESSOR_URL", "http://localhost:8001")
PROCESSOR_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "processor")
PROCESSOR_EXE = os.path.join(PROCESSOR_DIR, "processor.exe")

async def check_go_service() -> bool:
    """Checks if the Go microservice is running."""
    try:
        async with httpx.AsyncClient(timeout=1.5) as client:
            resp = await client.get(f"{GO_PROCESSOR_URL}/health")
            return resp.status_code == 200
    except Exception:
        return False

async def process_file_with_go(file_path: str, chunk_size: int = 700, chunk_overlap: int = 150) -> Dict[str, Any]:
    """
    Processes a file using the Go processor:
    Extracts text, splits into chunks, and computes 384-d normalized embeddings.
    Tries HTTP microservice first; falls back to direct processor.exe CLI.
    """
    is_live = await check_go_service()
    if is_live:
        try:
            async with httpx.AsyncClient(timeout=60.0) as client:
                resp = await client.post(
                    f"{GO_PROCESSOR_URL}/process",
                    json={
                        "file_path": file_path,
                        "chunk_size": chunk_size,
                        "chunk_overlap": chunk_overlap
                    }
                )
                if resp.status_code == 200:
                    return resp.json()
        except Exception as e:
            print(f"[ProcessorClient] Go HTTP request failed ({e}), falling back to CLI execution")

    # Fallback to CLI binary execution
    return run_processor_cli(file_path, chunk_size, chunk_overlap)

def run_processor_cli(file_path: str, chunk_size: int = 700, chunk_overlap: int = 150) -> Dict[str, Any]:
    """Runs the compiled processor.exe binary directly."""
    if not os.path.exists(PROCESSOR_EXE):
        # Attempt to compile if binary is missing
        print(f"[ProcessorClient] {PROCESSOR_EXE} not found, building with 'go build'...")
        cmd_build = ["go", "build", "-o", "processor.exe", "main.go"]
        subprocess.run(cmd_build, cwd=PROCESSOR_DIR, check=True)

    cmd = [
        PROCESSOR_EXE,
        "-file", file_path,
        "-chunk-size", str(chunk_size),
        "-overlap", str(chunk_overlap)
    ]
    proc = subprocess.run(cmd, cwd=PROCESSOR_DIR, capture_output=True, text=True, check=True)
    return json.loads(proc.stdout)

async def embed_texts_with_go(texts: List[str]) -> List[List[float]]:
    """Generates 384-d normalized vector embeddings for texts."""
    is_live = await check_go_service()
    if is_live:
        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                resp = await client.post(f"{GO_PROCESSOR_URL}/embed", json={"texts": texts})
                if resp.status_code == 200:
                    return resp.json().get("embeddings", [])
        except Exception:
            pass

    # High performance Python fallback matching the Go embedding algorithm exactly
    return [generate_embedding_py(t) for t in texts]

def generate_embedding_py(text: str, dim: int = 384) -> List[float]:
    """
    Python implementation matching the Go subword-hash embedding algorithm.
    Guarantees deterministic vector spaces between Go and Python.
    """
    vec = [0.0] * dim
    if not text:
        return vec

    words = text.lower().split()
    weights: Dict[str, float] = {}

    for w in words:
        clean = w.strip(",.!?;:\"'()[]{}*#-`")
        if not clean:
            continue
        weight = 1.0 + (len(clean) * 0.1 if len(clean) > 4 else 0.0)
        weights[clean] = weights.get(clean, 0.0) + weight

        # Subword trigrams
        if len(clean) >= 3:
            for i in range(len(clean) - 2):
                ng = clean[i:i+3]
                weights[f"ng:{ng}"] = weights.get(f"ng:{ng}", 0.0) + 0.5
        if len(clean) >= 4:
            for i in range(len(clean) - 3):
                ng = clean[i:i+4]
                weights[f"ng4:{ng}"] = weights.get(f"ng4:{ng}", 0.0) + 0.3

    for i in range(len(words) - 1):
        w1 = words[i].strip(",.!?;:\"'()[]{}*#-`")
        w2 = words[i+1].strip(",.!?;:\"'()[]{}*#-`")
        if w1 and w2:
            bi = f"bi:{w1}_{w2}"
            weights[bi] = weights.get(bi, 0.0) + 1.5

    seeds = [0x811c9dc5, 0x9e3779b9, 0x6a09e667, 0xbb67ae85]

    for tok, weight in weights.items():
        b_tok = tok.encode("utf-8")
        for s_idx, seed in enumerate(seeds):
            h = seed
            for b in b_tok:
                h = ((h ^ b) * 16777619) & 0xFFFFFFFF
            target_dim = h % dim
            sign = -1.0 if (h & 0x1000) != 0 else 1.0
            decay = 1.0 / (s_idx + 1)
            vec[target_dim] += sign * weight * decay

    norm_sq = sum(v * v for v in vec)
    if norm_sq > 0:
        norm = math.sqrt(norm_sq)
        vec = [v / norm for v in vec]

    return vec
