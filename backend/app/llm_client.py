import os
import json
import re
import httpx
from typing import List, Dict, Any, Optional
from dotenv import load_dotenv

# Load .env
env_path = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), ".env")
load_dotenv(env_path)

GROQ_API_KEY = os.getenv("GROQ_API") or os.getenv("GROQ_API_KEY") or ""
GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions"
DEFAULT_MODEL = "qwen/qwen3.8-27b"  # Fast, highly capable reasoning model on Groq


def normalize_answer_citations(answer_text: str, citation_map: Dict[int, Dict[str, Any]]) -> str:
    """Normalize citation numbers and common bold-number variants to [n] markers."""
    valid_numbers = set(citation_map)

    def normalize_marker(match: re.Match[str]) -> str:
        label = match.group(1) or match.group(2)
        number = int(label)
        if number in valid_numbers:
            return f"[{number}]"

        # Some model responses collapse adjacent references such as [2][4] to **24**.
        if len(label) > 1 and all(int(digit) in valid_numbers for digit in label):
            return "".join(f"[{digit}]" for digit in label)
        return match.group(0)

    answer_text = re.sub(
        r"(?<!\w)(?:\[(\d{1,3})\]|\*\*(\d{1,3})\*\*)(?=\s*(?:[.!?,;:]|$))",
        normalize_marker,
        answer_text,
    )
    # Drop stray single backslash lines occasionally emitted as Markdown hard breaks.
    return re.sub(r"(?m)^[ \t]*\\(?=[ \t]*$)[ \t]*\r?\n", "", answer_text)

async def call_groq(messages: List[Dict[str, str]], temperature: float = 0.2, max_tokens: int = 2500) -> str:
    """Calls Groq chat completion API."""
    if not GROQ_API_KEY:
        raise ValueError("GROQ_API key is not configured in .env file.")

    headers = {
        "Authorization": f"Bearer {GROQ_API_KEY}",
        "Content-Type": "application/json"
    }

    payload = {
        "model": DEFAULT_MODEL,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens
    }

    async with httpx.AsyncClient(timeout=45.0) as client:
        resp = await client.post(GROQ_API_URL, headers=headers, json=payload)
        if resp.status_code != 200:
            # Fallback to secondary model if primary has issues
            if "openai/gpt-oss-120b" not in DEFAULT_MODEL:
                payload["model"] = "openai/gpt-oss-120b"
                resp = await client.post(GROQ_API_URL, headers=headers, json=payload)

        if resp.status_code != 200:
            raise RuntimeError(f"Groq API error ({resp.status_code}): {resp.text}")

        data = resp.json()
        return data["choices"][0]["message"]["content"]

# Grounded RAG Chat
async def generate_grounded_answer(
    query: str,
    chunks: List[Dict[str, Any]],
    conversation_history: Optional[List[Dict[str, str]]] = None
) -> Dict[str, Any]:
    """
    Generates a NotebookLM-style response with inline citation markers [1], [2]
    and maps them to the source chunks.
    """
    if not chunks:
        # No context available
        return {
            "answer": "I don't have any sources selected or uploaded to answer this question. Please upload a source or check your active sources in the left panel.",
            "citations": []
        }

    # Build context with citation numbering
    context_parts = []
    citation_map = {}

    for i, c in enumerate(chunks, start=1):
        cit_num = i
        citation_map[cit_num] = {
            "citation_num": cit_num,
            "source_id": c["source_id"],
            "source_name": c["source_name"],
            "page_number": c.get("page_number", 1),
            "chunk_id": c["id"],
            "excerpt": c["content"][:300] + ("..." if len(c["content"]) > 300 else "")
        }
        context_parts.append(
            f"[{cit_num}] Source: {c['source_name']} (Page {c.get('page_number', 1)}):\n{c['content']}"
        )

    context_str = "\n\n".join(context_parts)

    system_prompt = (
        "You are ResearchLM, a concise research assistant. Answer strictly from the supplied sources.\n\n"
        "GUIDELINES:\n"
        "1. GROUNDING: Use only the supplied sources. Say briefly when they do not contain the answer.\n"
        "2. LENGTH: Answer the question directly. For a simple question, use 1-3 sentences. "
        "For a multi-part question, use at most 5 short bullets. Aim for 120 words or fewer unless the user asks for detail. "
        "Skip introductory and concluding filler; use headings only when they improve a longer answer.\n"
        "3. CITATIONS: Put an exact source marker such as [1] immediately after each supported claim. "
        "Use only the supplied marker numbers. Never bold, merge, or omit the square brackets around citation numbers.\n"
        "4. FORMATTING: Use clean standard Markdown with normal paragraphs and lists. Do not add stray backslashes for line breaks. "
        "Write inline math as $...$ and display equations as $$...$$.\n"
        "5. TONE: Clear, direct, and professional."
    )

    user_prompt = (
        f"SOURCES:\n{context_str}\n\n"
        f"USER QUESTION: {query}\n\n"
        "Answer the question directly and concisely. Cite every source-based claim with the exact markers [1], [2], etc."
    )

    messages = [{"role": "system", "content": system_prompt}]
    if conversation_history:
        for msg in conversation_history[-6:]:
            messages.append({"role": msg["role"], "content": msg["content"]})
    messages.append({"role": "user", "content": user_prompt})

    answer_text = await call_groq(messages, temperature=0.2, max_tokens=800)
    answer_text = normalize_answer_citations(answer_text, citation_map)

    # Detect which citations were actually used
    used_citations = []
    cited_numbers = {int(number) for number in re.findall(r"\[(\d+)\]", answer_text)}
    for cit_num, meta in citation_map.items():
        if cit_num in cited_numbers:
            used_citations.append(meta)

    # If the LLM omitted brackets or used generic ones, include top 3 retrieved chunks
    if not used_citations:
        used_citations = list(citation_map.values())[:3]

    return {
        "answer": answer_text,
        "citations": used_citations
    }

# NotebookLM Studio: Audio Overview (Podcast Generator)
async def generate_podcast_script(chunks: List[Dict[str, Any]], notebook_title: str) -> Dict[str, Any]:
    """Generates an engaging, deep-dive dialogue between two hosts: Alex and Morgan."""
    context_text = "\n\n".join([f"- {c['content']}" for c in chunks[:12]])

    prompt = f"""
You are the executive producer of 'Deep Dive', a NotebookLM audio podcast overview.
Two knowledgeable, enthusiastic co-hosts are discussing the uploaded research material:
- **Alex**: The curious, engaging host who connects ideas to the big picture and asks perceptive questions.
- **Morgan**: The sharp, analytical expert who breaks down technical mechanics, nuances, and data.

MATERIAL SUMMARY FROM SOURCES:
{context_text}

Generate a dynamic, natural conversational podcast script (about 6 to 10 alternating turns).
Make it feel like a real podcast episode: warm banter, "aha!" moments, analogies, and deep takeaways.

Respond ONLY with valid JSON in the following format:
{{
  "episode_title": "Catchy Title Here",
  "summary": "1-2 sentence overview of the conversation",
  "dialogue": [
    {{"speaker": "Alex", "text": "...", "duration_sec": 8}},
    {{"speaker": "Morgan", "text": "...", "duration_sec": 12}}
  ]
}}
"""
    messages = [
        {"role": "system", "content": "You are a master podcast producer. Output pure JSON only."},
        {"role": "user", "content": prompt}
    ]

    raw = await call_groq(messages, temperature=0.7)
    # Extract JSON cleanly
    clean_json = raw.strip()
    if "```json" in clean_json:
        clean_json = clean_json.split("```json")[1].split("```")[0].strip()
    elif "```" in clean_json:
        clean_json = clean_json.split("```")[1].split("```")[0].strip()

    try:
        return json.loads(clean_json)
    except Exception:
        return {
            "episode_title": f"Deep Dive: {notebook_title}",
            "summary": "An exploration of key concepts and breakthroughs from your sources.",
            "dialogue": [
                {"speaker": "Alex", "text": f"Welcome back! Today we're digging deep into {notebook_title}, and honestly, the insights here are fascinating.", "duration_sec": 7},
                {"speaker": "Morgan", "text": "Right, what caught my attention immediately was the foundational shift in how this approach handles complexity.", "duration_sec": 9},
                {"speaker": "Alex", "text": "So walk us through the core mechanism. What's the real game changer here?", "duration_sec": 6},
                {"speaker": "Morgan", "text": "The key breakthrough lies in bypassing recurrence entirely and relying on attention mechanisms across the whole sequence simultaneously.", "duration_sec": 10}
            ]
        }

# NotebookLM Studio: Study Guide
async def generate_study_guide(chunks: List[Dict[str, Any]], notebook_title: str) -> Dict[str, Any]:
    context_text = "\n\n".join([f"- {c['content']}" for c in chunks[:10]])
    prompt = f"""
Generate a comprehensive Study Guide based on the following material:
{context_text}

Format as markdown with:
# 📚 Study Guide: {notebook_title}
## 1. Core Summary & Big Picture
## 2. Key Concepts & Definitions
## 3. Practice Quiz (5 Questions with Expandable Answers)
## 4. Discussion Prompts & Essay Ideas
"""
    messages = [
        {"role": "system", "content": "You are an expert educator and academic researcher."},
        {"role": "user", "content": prompt}
    ]
    guide_text = await call_groq(messages, temperature=0.3)
    return {"title": f"Study Guide: {notebook_title}", "content": guide_text}

# NotebookLM Studio: Briefing Doc
async def generate_briefing_doc(chunks: List[Dict[str, Any]], notebook_title: str) -> Dict[str, Any]:
    context_text = "\n\n".join([f"- {c['content']}" for c in chunks[:10]])
    prompt = f"""
Generate an Executive Briefing Document based on the following material:
{context_text}

Format as clean, executive-ready markdown:
# 📋 Executive Briefing: {notebook_title}
## Executive Summary
## Key Findings & Core Innovations
## Technical / Methodological Details
## Implications & Strategic Takeaways
"""
    messages = [
        {"role": "system", "content": "You are a senior analyst drafting an executive briefing."},
        {"role": "user", "content": prompt}
    ]
    doc_text = await call_groq(messages, temperature=0.2)
    return {"title": f"Briefing Doc: {notebook_title}", "content": doc_text}

# NotebookLM Studio: FAQ
async def generate_faq(chunks: List[Dict[str, Any]], notebook_title: str) -> Dict[str, Any]:
    context_text = "\n\n".join([f"- {c['content']}" for c in chunks[:10]])
    prompt = f"""
Generate a Frequently Asked Questions (FAQ) guide based on the following material:
{context_text}

Format as markdown with 6-8 practical, insightful questions with clear answers citing specific details from the sources.
"""
    messages = [
        {"role": "system", "content": "You are an expert technical communicator."},
        {"role": "user", "content": prompt}
    ]
    faq_text = await call_groq(messages, temperature=0.3)
    return {"title": f"FAQ: {notebook_title}", "content": faq_text}
