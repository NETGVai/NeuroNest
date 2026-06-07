#!/usr/bin/env python3
"""
OpenMythos Inference Bridge Server

A lightweight FastAPI server that wraps the OpenMythos library and exposes
an OpenAI-compatible REST API for NeuroNest integration.

Usage:
    python3 scripts/openmythos_bridge.py --port 8200
"""

import argparse
import asyncio
import json
import time
import uuid
from contextlib import asynccontextmanager
from typing import Any, AsyncGenerator, Dict, List, Optional

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

# ---------------------------------------------------------------------------
# Model variant metadata
# ---------------------------------------------------------------------------

MODEL_VARIANTS: Dict[str, Dict[str, Any]] = {
    "mythos_1b":   {"params": "1B",   "vram_gb": 2,    "description": "Lightweight, fast inference"},
    "mythos_3b":   {"params": "3B",   "vram_gb": 6,    "description": "Balanced speed and quality"},
    "mythos_10b":  {"params": "10B",  "vram_gb": 20,   "description": "Strong reasoning capability"},
    "mythos_50b":  {"params": "50B",  "vram_gb": 100,  "description": "Advanced reasoning, multi-GPU"},
    "mythos_100b": {"params": "100B", "vram_gb": 200,  "description": "Research-grade, multi-node"},
    "mythos_500b": {"params": "500B", "vram_gb": 1000, "description": "Cluster deployment only"},
    "mythos_1t":   {"params": "1T",   "vram_gb": 2000, "description": "Full-scale, datacenter only"},
}

DEFAULT_N_LOOPS = 4
N_LOOPS_MIN = 1
N_LOOPS_MAX = 32

# ---------------------------------------------------------------------------
# Global state
# ---------------------------------------------------------------------------

_start_time: float = 0.0
_model_loaded: Optional[str] = None
_model_loading: bool = False
_model = None
_tokenizer = None


# ---------------------------------------------------------------------------
# GPU detection helper
# ---------------------------------------------------------------------------

def _detect_gpu() -> Optional[Dict[str, Any]]:
    """Detect CUDA GPU information via PyTorch."""
    try:
        import torch
        if torch.cuda.is_available():
            device_name = torch.cuda.get_device_name(0)
            vram_total = torch.cuda.get_device_properties(0).total_mem
            vram_used = torch.cuda.memory_allocated(0)
            return {
                "cuda_available": True,
                "device_name": device_name,
                "vram_total_mb": round(vram_total / (1024 * 1024)),
                "vram_used_mb": round(vram_used / (1024 * 1024)),
            }
        else:
            return {
                "cuda_available": False,
                "device_name": "",
                "vram_total_mb": 0,
                "vram_used_mb": 0,
            }
    except ImportError:
        return None


# ---------------------------------------------------------------------------
# Model loading
# ---------------------------------------------------------------------------

async def _load_default_model() -> None:
    """Attempt to load the default model on startup."""
    global _model_loaded, _model_loading, _model, _tokenizer
    _model_loading = True
    try:
        from open_mythos import MythosModel, MythosTokenizer
        _tokenizer = MythosTokenizer.from_pretrained("openmythos/mythos_3b")
        _model = MythosModel.from_pretrained("openmythos/mythos_3b")
        _model_loaded = "mythos_3b"
    except Exception:
        # Model loading is optional — bridge can still serve health/models endpoints
        _model_loaded = None
    finally:
        _model_loading = False


# ---------------------------------------------------------------------------
# Pydantic request/response models
# ---------------------------------------------------------------------------

class ChatMessage(BaseModel):
    role: str
    content: str


class StreamOptions(BaseModel):
    include_usage: Optional[bool] = False


class ChatCompletionRequest(BaseModel):
    model: str
    messages: List[ChatMessage]
    stream: Optional[bool] = False
    temperature: Optional[float] = Field(default=0.7, ge=0.0, le=2.0)
    max_tokens: Optional[int] = Field(default=2048, ge=1)
    n_loops: Optional[int] = None
    stream_options: Optional[StreamOptions] = None


# ---------------------------------------------------------------------------
# Token counting helper
# ---------------------------------------------------------------------------

def _count_tokens(text: str) -> int:
    """Approximate token count. Uses tokenizer if available, else word-based estimate."""
    if _tokenizer is not None:
        try:
            return len(_tokenizer.encode(text))
        except Exception:
            pass
    # Rough approximation: ~4 chars per token
    return max(1, len(text) // 4)


# ---------------------------------------------------------------------------
# Inference helper
# ---------------------------------------------------------------------------

async def _generate_text(
    messages: List[ChatMessage],
    model_name: str,
    temperature: float,
    max_tokens: int,
    n_loops: int,
) -> str:
    """Run inference using the loaded OpenMythos model. Returns generated text."""
    if _model is None:
        # Fallback: return a placeholder when model isn't loaded (for testing)
        prompt_text = " ".join(m.content for m in messages)
        return f"[OpenMythos {model_name} n_loops={n_loops}] Echo: {prompt_text[:200]}"

    try:
        import torch

        prompt = "\n".join(f"{m.role}: {m.content}" for m in messages)
        input_ids = _tokenizer.encode(prompt, return_tensors="pt")
        if torch.cuda.is_available():
            input_ids = input_ids.cuda()
            _model.cuda()

        with torch.no_grad():
            output = _model.generate(
                input_ids,
                max_new_tokens=max_tokens,
                temperature=temperature,
                n_loops=n_loops,
            )
        generated_ids = output[0][input_ids.shape[1]:]
        return _tokenizer.decode(generated_ids, skip_special_tokens=True)
    except RuntimeError as e:
        if "out of memory" in str(e).lower() or "CUDA" in str(e):
            raise HTTPException(
                status_code=500,
                detail={
                    "error": {
                        "message": "GPU out of memory",
                        "type": "resource_exhausted",
                    }
                },
            )
        raise


async def _generate_stream(
    messages: List[ChatMessage],
    model_name: str,
    temperature: float,
    max_tokens: int,
    n_loops: int,
) -> AsyncGenerator[str, None]:
    """Yield token fragments for streaming mode."""
    # For now, generate full text then yield token-by-token.
    # A real implementation would hook into the model's token callback.
    full_text = await _generate_text(messages, model_name, temperature, max_tokens, n_loops)
    # Simulate token-by-token streaming by splitting into words
    tokens = full_text.split(" ")
    for i, token in enumerate(tokens):
        fragment = token if i == 0 else " " + token
        yield fragment
        await asyncio.sleep(0)  # yield control


# ---------------------------------------------------------------------------
# FastAPI application
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup/shutdown lifecycle."""
    global _start_time
    _start_time = time.time()
    # Attempt to load default model in background
    asyncio.create_task(_load_default_model())
    yield


app = FastAPI(title="OpenMythos Bridge", version="1.0.0", lifespan=lifespan)


# ---------------------------------------------------------------------------
# GET /health
# ---------------------------------------------------------------------------

@app.get("/health")
async def health():
    """Health check endpoint."""
    gpu_info = _detect_gpu()
    return JSONResponse(
        status_code=200,
        content={
            "status": "ok" if _model_loaded and not _model_loading else ("loading" if _model_loading else "ok"),
            "model_loaded": _model_loaded,
            "uptime_seconds": round(time.time() - _start_time, 2),
            "gpu": gpu_info,
        },
    )


# ---------------------------------------------------------------------------
# GET /v1/models
# ---------------------------------------------------------------------------

@app.get("/v1/models")
async def list_models():
    """List available model variants in OpenAI format."""
    models = []
    for variant_id, meta in MODEL_VARIANTS.items():
        models.append({
            "id": variant_id,
            "object": "model",
            "created": int(_start_time) if _start_time else 0,
            "owned_by": "openmythos",
            "meta": {
                "params": meta["params"],
                "vram_gb": meta["vram_gb"],
                "description": meta["description"],
            },
        })
    return {"object": "list", "data": models}


# ---------------------------------------------------------------------------
# POST /v1/chat/completions
# ---------------------------------------------------------------------------

@app.post("/v1/chat/completions")
async def chat_completions(request: ChatCompletionRequest):
    """OpenAI-compatible chat completions endpoint."""

    # Validate model variant
    if request.model not in MODEL_VARIANTS:
        raise HTTPException(
            status_code=404,
            detail={
                "error": {
                    "message": f"Model '{request.model}' not found",
                    "type": "model_not_found",
                }
            },
        )

    # Check if model is still loading
    if _model_loading:
        raise HTTPException(
            status_code=503,
            detail={
                "error": {
                    "message": "Model loading, please retry",
                    "type": "service_unavailable",
                }
            },
        )

    # Resolve n_loops with validation
    n_loops = request.n_loops if request.n_loops is not None else DEFAULT_N_LOOPS
    if not isinstance(n_loops, int) or n_loops < N_LOOPS_MIN or n_loops > N_LOOPS_MAX:
        raise HTTPException(
            status_code=400,
            detail={
                "error": {
                    "message": f"n_loops must be {N_LOOPS_MIN}-{N_LOOPS_MAX}",
                    "type": "invalid_request",
                }
            },
        )

    temperature = request.temperature if request.temperature is not None else 0.7
    max_tokens = request.max_tokens if request.max_tokens is not None else 2048
    completion_id = f"chatcmpl-{uuid.uuid4().hex[:12]}"

    # Calculate prompt tokens
    prompt_text = " ".join(m.content for m in request.messages)
    prompt_tokens = _count_tokens(prompt_text)

    if request.stream:
        return _stream_response(
            request, completion_id, prompt_tokens, temperature, max_tokens, n_loops
        )
    else:
        return await _non_stream_response(
            request, completion_id, prompt_tokens, temperature, max_tokens, n_loops
        )


# ---------------------------------------------------------------------------
# Non-streaming response
# ---------------------------------------------------------------------------

async def _non_stream_response(
    request: ChatCompletionRequest,
    completion_id: str,
    prompt_tokens: int,
    temperature: float,
    max_tokens: int,
    n_loops: int,
) -> JSONResponse:
    """Return a single JSON response with the full completion."""
    generated = await _generate_text(
        request.messages, request.model, temperature, max_tokens, n_loops
    )
    completion_tokens = _count_tokens(generated)

    return JSONResponse(
        content={
            "id": completion_id,
            "object": "chat.completion",
            "created": int(time.time()),
            "model": request.model,
            "choices": [
                {
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": generated,
                    },
                    "finish_reason": "stop",
                }
            ],
            "usage": {
                "prompt_tokens": prompt_tokens,
                "completion_tokens": completion_tokens,
                "total_tokens": prompt_tokens + completion_tokens,
            },
        }
    )


# ---------------------------------------------------------------------------
# Streaming response
# ---------------------------------------------------------------------------

def _stream_response(
    request: ChatCompletionRequest,
    completion_id: str,
    prompt_tokens: int,
    temperature: float,
    max_tokens: int,
    n_loops: int,
) -> StreamingResponse:
    """Return an SSE streaming response matching OpenAI format."""
    include_usage = (
        request.stream_options is not None
        and request.stream_options.include_usage is True
    )

    async def event_generator() -> AsyncGenerator[str, None]:
        completion_tokens = 0
        created = int(time.time())

        async for fragment in _generate_stream(
            request.messages, request.model, temperature, max_tokens, n_loops
        ):
            completion_tokens += _count_tokens(fragment)
            chunk = {
                "id": completion_id,
                "object": "chat.completion.chunk",
                "created": created,
                "model": request.model,
                "choices": [
                    {
                        "index": 0,
                        "delta": {"content": fragment},
                        "finish_reason": None,
                    }
                ],
            }
            yield f"data: {json.dumps(chunk)}\n\n"

        # Final chunk with finish_reason
        final_chunk: Dict[str, Any] = {
            "id": completion_id,
            "object": "chat.completion.chunk",
            "created": created,
            "model": request.model,
            "choices": [
                {
                    "index": 0,
                    "delta": {},
                    "finish_reason": "stop",
                }
            ],
        }
        if include_usage:
            final_chunk["usage"] = {
                "prompt_tokens": prompt_tokens,
                "completion_tokens": completion_tokens,
                "total_tokens": prompt_tokens + completion_tokens,
            }
        yield f"data: {json.dumps(final_chunk)}\n\n"

        # Terminator
        yield "data: [DONE]\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


# ---------------------------------------------------------------------------
# Error handlers
# ---------------------------------------------------------------------------

@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException):
    """Return errors in OpenAI-compatible format."""
    detail = exc.detail
    if isinstance(detail, dict):
        return JSONResponse(status_code=exc.status_code, content=detail)
    return JSONResponse(
        status_code=exc.status_code,
        content={
            "error": {
                "message": str(detail),
                "type": "error",
            }
        },
    )


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="OpenMythos Inference Bridge Server")
    parser.add_argument("--port", type=int, default=8200, help="Port to listen on (default: 8200)")
    args = parser.parse_args()

    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=args.port, log_level="info")


if __name__ == "__main__":
    main()
