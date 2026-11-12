// Copyright (c) 2026 TokenJunction LLC
// SPDX-License-Identifier: MIT
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ installed: true });
});
