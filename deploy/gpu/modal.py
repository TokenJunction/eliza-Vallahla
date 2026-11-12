# Template only. Modal scales this function to zero. Do not commit a key.
import os

TENSOR_PARALLEL_SIZE = int(os.environ.get("TENSOR_PARALLEL_SIZE", "1"))

# modal.App("valhalla-vllm")
# @app.function(gpu="A10G", scaledown_window=120, timeout=120)
# def serve():
#     Start vLLM with --tensor-parallel-size TENSOR_PARALLEL_SIZE.
#     The router calls GPU_NODE_URL only when GPU_MONTHLY_CAP_USD is above 0.
