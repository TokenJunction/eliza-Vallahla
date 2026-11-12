#!/bin/sh
# Copyright (c) 2026 TokenJunction LLC
# SPDX-License-Identifier: MIT
set -eu
cd "$(dirname "$0")/.."
exec make debug "$@"
