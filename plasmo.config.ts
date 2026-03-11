import { defineConfig } from "plasmo"

export default defineConfig({
  manifest: {
    host_permissions: ["https://*/*"],
    permissions: ["activeTab"]
  }
})
