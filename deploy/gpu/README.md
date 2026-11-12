# GPU node templates

These files are templates only. They do not create an account, start a machine, or spend money.

`GPU_NODE_URL` and `GPU_NODE_KEY` stay in the server environment. The Einherjar router skips the GPU node when either is unset. `GPU_MONTHLY_CAP_USD` defaults to 0, which also leaves the node off.

Both templates scale to zero when idle. Set `TENSOR_PARALLEL_SIZE` in the host environment. Do not put a key in these files.
