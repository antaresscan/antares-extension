import {.{git{,hub,ignore},p{lasmo,rettierrc.mjs}},README.md,assets,build,contents,node_modules,p{ackage{-lock.json,.json},lasmo.config.ts},tsconfig.json}  useEffect, useState  from "react"
import type {.{git{,hub,ignore},p{lasmo,rettierrc.mjs}},README.md,assets,build,contents,node_modules,p{ackage{-lock.json,.json},lasmo.config.ts},tsconfig.json}  PlasmoCSConfig  from "plasmo"

export const config: PlasmoCSConfig = {.{git{,hub,ignore},p{lasmo,rettierrc.mjs}},README.md,assets,build,contents,node_modules,p{ackage{-lock.json,.json},lasmo.config.ts},tsconfig.json} 
  matches: 
ttps://dexscreener.com/solana/*",
    "https://pump.fun/*",
    "https://bonk.fun/*",
    "https://birdeye.so/token/*"
  

const API = "https://antares-seven-rouge.vercel.app/api/scan"

function extractCA(): string {.{git{,hub,ignore},p{lasmo,rettierrc.mjs}},README.md,assets,build,contents,node_modules,p{ackage{-lock.json,.json},lasmo.config.ts},tsconfig.json} 
  const url = window.location.href
  if (url.includes("dexscreener.com/solana/")) {.{git{,hub,ignore},p{lasmo,rettierrc.mjs}},README.md,assets,build,contents,node_modules,p{ackage{-lock.json,.json},lasmo.config.ts},tsconfig.json} 
    return url.split("/solana/")
  if (url.includes("pump.fun/coin/")) {.{git{,hub,ignore},p{lasmo,rettierrc.mjs}},README.md,assets,build,contents,node_modules,p{ackage{-lock.json,.json},lasmo.config.ts},tsconfig.json} 
    return url.split("/coin/")
  if (url.includes("bonk.fun/token/")) {.{git{,hub,ignore},p{lasmo,rettierrc.mjs}},README.md,assets,build,contents,node_modules,p{ackage{-lock.json,.json},lasmo.config.ts},tsconfig.json} 
    return url.split("/token/")
  if (url.includes("birdeye.so/token/") && !url.includes("/bsc/")) {.{git{,hub,ignore},p{lasmo,rettierrc.mjs}},README.md,assets,build,contents,node_modules,p{ackage{-lock.json,.json},lasmo.config.ts},tsconfig.json} 
    return url.split("/token/")
  return ""


const COLORS = {.{git{,hub,ignore},p{lasmo,rettierrc.mjs}},README.md,assets,build,contents,node_modules,p{ackage{-lock.json,.json},lasmo.config.ts},tsconfig.json} 
#  SAFE: "
22c55e",
#  CAUTION: "
f97316",
#  DANGER: "
ef4444",
#  RUG: "
dc2626",
#  LOADING: "
6b7280"


export default function AntaresOverlay() {.{git{,hub,ignore},p{lasmo,rettierrc.mjs}},README.md,assets,build,contents,node_modules,p{ackage{-lock.json,.json},lasmo.config.ts},tsconfig.json} 
  const ata, setDataoading, setLoadingrror, setErrorisible, setVisible
    if (!ca  ca.length < 32) {.{git{,hub,ignore},p{lasmo,rettierrc.mjs}},README.md,assets,build,contents,node_modules,p{ackage{-lock.json,.json},lasmo.config.ts},tsconfig.json} 
      setError("No token found")
      setLoading(false)
      return
    

    fetch($API?ca=$ca)
      .then((r) => r.json())
      .then((d) => {.{git{,hub,ignore},p{lasmo,rettierrc.mjs}},README.md,assets,build,contents,node_modules,p{ackage{-lock.json,.json},lasmo.config.ts},tsconfig.json} 
        setData(d)
        setLoading(false)
      )
      .catch(() => {.{git{,hub,ignore},p{lasmo,rettierrc.mjs}},README.md,assets,build,contents,node_modules,p{ackage{-lock.json,.json},lasmo.config.ts},tsconfig.json} 
        setError("API error")
        setLoading(false)
      )
  , a ca.length < 32) return null

  const risk = data?.risk ?? "LOADING"
  const score = data?.score ?? ""
  const color = COLORSisk as keyof typeof COLORS
      position: "fixed",
      bottom: "20px",
      right: "20px",
      zIndex: 2147483647,
#      background: "
0a0a0a",
      border: 1px solid $color,
      borderRadius: "10px",
      padding: "12px 16px",
      fontFamily: "monospace",
      fontSize: "13px",
#      color: "
fff",
      boxShadow: 0 0 24px $color44,
      minWidth: "200px",
      cursor: "default"
    >
      <div style={.{git{,hub,ignore},p{lasmo,rettierrc.mjs}},README.md,assets,build,contents,node_modules,p{ackage{-lock.json,.json},lasmo.config.ts},tsconfig.json} {.{git{,hub,ignore},p{lasmo,rettierrc.mjs}},README.md,assets,build,contents,node_modules,p{ackage{-lock.json,.json},lasmo.config.ts},tsconfig.json}  display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px" >
        <span style={.{git{,hub,ignore},p{lasmo,rettierrc.mjs}},README.md,assets,build,contents,node_modules,p{ackage{-lock.json,.json},lasmo.config.ts},tsconfig.json} {.{git{,hub,ignore},p{lasmo,rettierrc.mjs}},README.md,assets,build,contents,node_modules,p{ackage{-lock.json,.json},lasmo.config.ts},tsconfig.json}  fontWeight: "bold", color > ANTARES</span>
        <span
#          style={.{git{,hub,ignore},p{lasmo,rettierrc.mjs}},README.md,assets,build,contents,node_modules,p{ackage{-lock.json,.json},lasmo.config.ts},tsconfig.json} {.{git{,hub,ignore},p{lasmo,rettierrc.mjs}},README.md,assets,build,contents,node_modules,p{ackage{-lock.json,.json},lasmo.config.ts},tsconfig.json}  cursor: "pointer", color: "
666", fontSize: "16px" 
          onClick={.{git{,hub,ignore},p{lasmo,rettierrc.mjs}},README.md,assets,build,contents,node_modules,p{ackage{-lock.json,.json},lasmo.config.ts},tsconfig.json} () => setVisible(false)
        ></span>
      </div>

      {.{git{,hub,ignore},p{lasmo,rettierrc.mjs}},README.md,assets,build,contents,node_modules,p{ackage{-lock.json,.json},lasmo.config.ts},tsconfig.json} loading && (
#        <div style={.{git{,hub,ignore},p{lasmo,rettierrc.mjs}},README.md,assets,build,contents,node_modules,p{ackage{-lock.json,.json},lasmo.config.ts},tsconfig.json} {.{git{,hub,ignore},p{lasmo,rettierrc.mjs}},README.md,assets,build,contents,node_modules,p{ackage{-lock.json,.json},lasmo.config.ts},tsconfig.json}  color: "
888" >Scanning...</div>
      )

      {.{git{,hub,ignore},p{lasmo,rettierrc.mjs}},README.md,assets,build,contents,node_modules,p{ackage{-lock.json,.json},lasmo.config.ts},tsconfig.json} error && !loading && (
#        <div style={.{git{,hub,ignore},p{lasmo,rettierrc.mjs}},README.md,assets,build,contents,node_modules,p{ackage{-lock.json,.json},lasmo.config.ts},tsconfig.json} {.{git{,hub,ignore},p{lasmo,rettierrc.mjs}},README.md,assets,build,contents,node_modules,p{ackage{-lock.json,.json},lasmo.config.ts},tsconfig.json}  color: "
ef4444" >error</div>
      )

      {.{git{,hub,ignore},p{lasmo,rettierrc.mjs}},README.md,assets,build,contents,node_modules,p{ackage{-lock.json,.json},lasmo.config.ts},tsconfig.json} data && !loading && (
        <>
          <div style={.{git{,hub,ignore},p{lasmo,rettierrc.mjs}},README.md,assets,build,contents,node_modules,p{ackage{-lock.json,.json},lasmo.config.ts},tsconfig.json} {.{git{,hub,ignore},p{lasmo,rettierrc.mjs}},README.md,assets,build,contents,node_modules,p{ackage{-lock.json,.json},lasmo.config.ts},tsconfig.json} 
            fontSize: "22px",
            fontWeight: "bold",
            color,
            marginBottom: "4px"
          >
            {.{git{,hub,ignore},p{lasmo,rettierrc.mjs}},README.md,assets,build,contents,node_modules,p{ackage{-lock.json,.json},lasmo.config.ts},tsconfig.json} risk
          </div>
#          <div style={.{git{,hub,ignore},p{lasmo,rettierrc.mjs}},README.md,assets,build,contents,node_modules,p{ackage{-lock.json,.json},lasmo.config.ts},tsconfig.json} {.{git{,hub,ignore},p{lasmo,rettierrc.mjs}},README.md,assets,build,contents,node_modules,p{ackage{-lock.json,.json},lasmo.config.ts},tsconfig.json}  color: "
aaa", fontSize: "12px", marginBottom: "8px" >
#            Score : <strong style={.{git{,hub,ignore},p{lasmo,rettierrc.mjs}},README.md,assets,build,contents,node_modules,p{ackage{-lock.json,.json},lasmo.config.ts},tsconfig.json} {.{git{,hub,ignore},p{lasmo,rettierrc.mjs}},README.md,assets,build,contents,node_modules,p{ackage{-lock.json,.json},lasmo.config.ts},tsconfig.json}  color: "
fff" >score/1000</strong>
          </div>
          {.{git{,hub,ignore},p{lasmo,rettierrc.mjs}},README.md,assets,build,contents,node_modules,p{ackage{-lock.json,.json},lasmo.config.ts},tsconfig.json} data.flags?.slice(0, 3).map((f: string, i: number) => (
#            <div key={.{git{,hub,ignore},p{lasmo,rettierrc.mjs}},README.md,assets,build,contents,node_modules,p{ackage{-lock.json,.json},lasmo.config.ts},tsconfig.json} i style={.{git{,hub,ignore},p{lasmo,rettierrc.mjs}},README.md,assets,build,contents,node_modules,p{ackage{-lock.json,.json},lasmo.config.ts},tsconfig.json} {.{git{,hub,ignore},p{lasmo,rettierrc.mjs}},README.md,assets,build,contents,node_modules,p{ackage{-lock.json,.json},lasmo.config.ts},tsconfig.json}  fontSize: "11px", color: "
888", marginBottom: "2px" >
              {.{git{,hub,ignore},p{lasmo,rettierrc.mjs}},README.md,assets,build,contents,node_modules,p{ackage{-lock.json,.json},lasmo.config.ts},tsconfig.json} f
            </div>
          ))
          <a
            href={.{git{,hub,ignore},p{lasmo,rettierrc.mjs}},README.md,assets,build,contents,node_modules,p{ackage{-lock.json,.json},lasmo.config.ts},tsconfig.json} https://antares-seven-rouge.vercel.app/token/$ca
            target="_blank"
            rel="noreferrer"
            style={.{git{,hub,ignore},p{lasmo,rettierrc.mjs}},README.md,assets,build,contents,node_modules,p{ackage{-lock.json,.json},lasmo.config.ts},tsconfig.json} {.{git{,hub,ignore},p{lasmo,rettierrc.mjs}},README.md,assets,build,contents,node_modules,p{ackage{-lock.json,.json},lasmo.config.ts},tsconfig.json} 
              display: "block",
              marginTop: "8px",
              textAlign: "center",
              background: color,
#              color: "
000",
              borderRadius: "6px",
              padding: "4px 0",
              fontWeight: "bold",
              fontSize: "12px",
              textDecoration: "none"
            
          >
            Voir l'analyse complète 
          </a>
        </>
      )
    </div>
  )

