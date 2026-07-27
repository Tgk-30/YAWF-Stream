import path from "path"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import { inspectAttr } from 'plugin-inspect-react-code'

// The site is mounted under a path prefix on a domain we do not own the root of,
// so the prefix is baked into the build. SITE_BASE lets one source tree ship to
// more than one mount, for example /debridstreamer on tgk30.com and /streamer on
// yawf.com. Always normalized to leading and trailing slashes.
const siteBase = `/${(process.env.SITE_BASE ?? 'debridstreamer').replace(/^\/+|\/+$/g, '')}/`

// https://vite.dev/config/
export default defineConfig(({ command }) => ({
  base: siteBase,
  plugins: [...(command === 'serve' ? [inspectAttr()] : []), react()],
  server: {
    port: 3000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
}));
