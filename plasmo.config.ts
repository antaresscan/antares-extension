/**
 * Plasmo configuration
 * @see https://docs.plasmo.com/framework/customization/plasmo-config-ts
 */
const config = {
  manifest: {
    host_permissions: [
      "https://dexscreener.com/*",
      "https://birdeye.so/*",
      "https://raydium.io/*",
      "https://pump.fun/*",
      "https://jup.ag/*",
      "https://solscan.io/*",
      "https://defined.fi/*",
      "https://www.geckoterminal.com/*",
      "https://photon-sol.tinyastro.io/*",
      "https://neo.bullx.io/*",
      "https://antares-extension.vercel.app/*",
      "https://fonts.googleapis.com/*",
      "https://fonts.gstatic.com/*"
    ],
    permissions: ["activeTab"]
  }
}

export default config
