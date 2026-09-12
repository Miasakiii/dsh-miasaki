// 由 scripts/derive-skins.mjs 生成，勿手改；源 = dsh-miasaki-desktop/themes/kurkuriel.skin.css
// 语义见 design/2026-09-12-appearance-m2-design.md §2：{light,dark} 同值对（static 明度中立，
// 明暗语义由官方 alias 端点选择承载；body inline 覆盖 static 可回溯 alias，§1.2 实机已证）。
export const name = "kurkuriel"

export const meta = {
  "id": "kurkuriel",
  "label": "狂狂帝",
  "preferredScheme": "light"
}

export const tokens = {
  "--dsh-scrollbar-thumb": {
    "light": "#c8bdb3",
    "dark": "#c8bdb3"
  },
  "--dsh-scrollbar-thumb-hover": {
    "light": "#a1958b",
    "dark": "#a1958b"
  },
  "--dsh-state-ongoing": {
    "light": "#9e1b1b",
    "dark": "#9e1b1b"
  },
  "--dsl-code-block-banner-background-color": {
    "light": "#f0ebe6",
    "dark": "#f0ebe6"
  },
  "--dsw-alias-bg-base": {
    "light": "rgba(247, 244, 241, .93)",
    "dark": "rgba(247, 244, 241, .93)"
  },
  "--dsw-alias-bg-layer-1": {
    "light": "rgba(252, 250, 248, .94)",
    "dark": "rgba(252, 250, 248, .94)"
  },
  "--dsw-alias-bg-layer-2": {
    "light": "rgba(255, 255, 255, .96)",
    "dark": "rgba(255, 255, 255, .96)"
  },
  "--dsw-alias-bg-module-platform": {
    "light": "rgba(252, 250, 248, .94)",
    "dark": "rgba(252, 250, 248, .94)"
  },
  "--dsw-alias-bg-overlay": {
    "light": "rgba(255, 255, 255, .97)",
    "dark": "rgba(255, 255, 255, .97)"
  },
  "--dsw-alias-brand-primary-new-colorprimary-new-color": {
    "light": "#9e1b1b",
    "dark": "#9e1b1b"
  },
  "--dsw-hovercard-bg": {
    "light": "#ffffff",
    "dark": "#ffffff"
  },
  "--dsw-linear-gradient-think": {
    "light": "linear-gradient(180deg, #f7f4f1 20.19%, rgba(247, 244, 241, 0) 100%)",
    "dark": "linear-gradient(180deg, #f7f4f1 20.19%, rgba(247, 244, 241, 0) 100%)"
  },
  "--dsw-linear-think-select": {
    "light": "linear-gradient(180deg, #ffffff 20.19%, rgba(255, 255, 255, 0) 100%)",
    "dark": "linear-gradient(180deg, #ffffff 20.19%, rgba(255, 255, 255, 0) 100%)"
  },
  "--dsw-specific-sidebar-fill": {
    "light": "rgba(252, 250, 248, .93)",
    "dark": "rgba(252, 250, 248, .93)"
  },
  "--dsw-static-amber-100": {
    "light": "#ede2c8",
    "dark": "#ede2c8"
  },
  "--dsw-static-amber-400": {
    "light": "#b89a5c",
    "dark": "#b89a5c"
  },
  "--dsw-static-amber-500": {
    "light": "#9c8149",
    "dark": "#9c8149"
  },
  "--dsw-static-amber-600": {
    "light": "#7f693a",
    "dark": "#7f693a"
  },
  "--dsw-static-amber-900": {
    "light": "#3a3220",
    "dark": "#3a3220"
  },
  "--dsw-static-blue-100": {
    "light": "#dadee6",
    "dark": "#dadee6"
  },
  "--dsw-static-blue-300": {
    "light": "#a6adbb",
    "dark": "#a6adbb"
  },
  "--dsw-static-blue-400": {
    "light": "#7a8294",
    "dark": "#7a8294"
  },
  "--dsw-static-blue-450": {
    "light": "#6a7284",
    "dark": "#6a7284"
  },
  "--dsw-static-blue-50": {
    "light": "#eceef2",
    "dark": "#eceef2"
  },
  "--dsw-static-blue-500": {
    "light": "#5e6572",
    "dark": "#5e6572"
  },
  "--dsw-static-blue-50p": {
    "light": "#e8ebef",
    "dark": "#e8ebef"
  },
  "--dsw-static-blue-600": {
    "light": "#4a505c",
    "dark": "#4a505c"
  },
  "--dsw-static-blue-75": {
    "light": "#e2e6ec",
    "dark": "#e2e6ec"
  },
  "--dsw-static-blue-800": {
    "light": "#2e323b",
    "dark": "#2e323b"
  },
  "--dsw-static-blue-900": {
    "light": "#20232a",
    "dark": "#20232a"
  },
  "--dsw-static-blue-950": {
    "light": "#16181d",
    "dark": "#16181d"
  },
  "--dsw-static-deepseek-100": {
    "light": "#f2dcdd",
    "dark": "#f2dcdd"
  },
  "--dsw-static-deepseek-200": {
    "light": "#ecc8c9",
    "dark": "#ecc8c9"
  },
  "--dsw-static-deepseek-300": {
    "light": "#dfa3a5",
    "dark": "#dfa3a5"
  },
  "--dsw-static-deepseek-400": {
    "light": "#b52525",
    "dark": "#b52525"
  },
  "--dsw-static-deepseek-450": {
    "light": "#9e1b1b",
    "dark": "#9e1b1b"
  },
  "--dsw-static-deepseek-50": {
    "light": "#f7e9ea",
    "dark": "#f7e9ea"
  },
  "--dsw-static-deepseek-500": {
    "light": "#8f1616",
    "dark": "#8f1616"
  },
  "--dsw-static-deepseek-600": {
    "light": "#7a1212",
    "dark": "#7a1212"
  },
  "--dsw-static-deepseek-700-delete": {
    "light": "#631010",
    "dark": "#631010"
  },
  "--dsw-static-deepseek-800": {
    "light": "#4e2020",
    "dark": "#4e2020"
  },
  "--dsw-static-deepseek-900": {
    "light": "#33191a",
    "dark": "#33191a"
  },
  "--dsw-static-green-100": {
    "light": "#dce7d9",
    "dark": "#dce7d9"
  },
  "--dsw-static-green-400": {
    "light": "#5e8f6b",
    "dark": "#5e8f6b"
  },
  "--dsw-static-green-500": {
    "light": "#46734f",
    "dark": "#46734f"
  },
  "--dsw-static-green-900": {
    "light": "#1f3326",
    "dark": "#1f3326"
  },
  "--dsw-static-neutral-00": {
    "light": "#f7f4f1",
    "dark": "#f7f4f1"
  },
  "--dsw-static-neutral-100": {
    "light": "#e2dbd4",
    "dark": "#e2dbd4"
  },
  "--dsw-static-neutral-1000": {
    "light": "#0a0807",
    "dark": "#0a0807"
  },
  "--dsw-static-neutral-150": {
    "light": "#d6cdc4",
    "dark": "#d6cdc4"
  },
  "--dsw-static-neutral-200": {
    "light": "#c8bdb3",
    "dark": "#c8bdb3"
  },
  "--dsw-static-neutral-250": {
    "light": "#b9ada2",
    "dark": "#b9ada2"
  },
  "--dsw-static-neutral-300": {
    "light": "#a1958b",
    "dark": "#a1958b"
  },
  "--dsw-static-neutral-400": {
    "light": "#8a7e74",
    "dark": "#8a7e74"
  },
  "--dsw-static-neutral-50": {
    "light": "#fcfaf8",
    "dark": "#fcfaf8"
  },
  "--dsw-static-neutral-500": {
    "light": "#74685e",
    "dark": "#74685e"
  },
  "--dsw-static-neutral-550": {
    "light": "#695e55",
    "dark": "#695e55"
  },
  "--dsw-static-neutral-600": {
    "light": "#5f554c",
    "dark": "#5f554c"
  },
  "--dsw-static-neutral-700": {
    "light": "#4b433c",
    "dark": "#4b433c"
  },
  "--dsw-static-neutral-800": {
    "light": "#2e2925",
    "dark": "#2e2925"
  },
  "--dsw-static-neutral-850": {
    "light": "#241f1c",
    "dark": "#241f1c"
  },
  "--dsw-static-neutral-900": {
    "light": "#151210",
    "dark": "#151210"
  },
  "--dsw-static-neutral-bluish-00": {
    "light": "#f7f4f1",
    "dark": "#f7f4f1"
  },
  "--dsw-static-neutral-bluish-100": {
    "light": "#e2dbd4",
    "dark": "#e2dbd4"
  },
  "--dsw-static-neutral-bluish-1000": {
    "light": "#0a0807",
    "dark": "#0a0807"
  },
  "--dsw-static-neutral-bluish-150": {
    "light": "#d6cdc4",
    "dark": "#d6cdc4"
  },
  "--dsw-static-neutral-bluish-200": {
    "light": "#c8bdb3",
    "dark": "#c8bdb3"
  },
  "--dsw-static-neutral-bluish-300": {
    "light": "#a1958b",
    "dark": "#a1958b"
  },
  "--dsw-static-neutral-bluish-400": {
    "light": "#8a7e74",
    "dark": "#8a7e74"
  },
  "--dsw-static-neutral-bluish-50": {
    "light": "#fcfaf8",
    "dark": "#fcfaf8"
  },
  "--dsw-static-neutral-bluish-500": {
    "light": "#74685e",
    "dark": "#74685e"
  },
  "--dsw-static-neutral-bluish-60": {
    "light": "#f0ebe6",
    "dark": "#f0ebe6"
  },
  "--dsw-static-neutral-bluish-600": {
    "light": "#5f554c",
    "dark": "#5f554c"
  },
  "--dsw-static-neutral-bluish-700": {
    "light": "#4b433c",
    "dark": "#4b433c"
  },
  "--dsw-static-neutral-bluish-75": {
    "light": "#e9e3dd",
    "dark": "#e9e3dd"
  },
  "--dsw-static-neutral-bluish-750": {
    "light": "#3c362f",
    "dark": "#3c362f"
  },
  "--dsw-static-neutral-bluish-800": {
    "light": "#2e2925",
    "dark": "#2e2925"
  },
  "--dsw-static-neutral-bluish-850": {
    "light": "#241f1c",
    "dark": "#241f1c"
  },
  "--dsw-static-neutral-bluish-875": {
    "light": "#1c1815",
    "dark": "#1c1815"
  },
  "--dsw-static-neutral-bluish-900": {
    "light": "#151210",
    "dark": "#151210"
  },
  "--dsw-static-neutral-bluish-950": {
    "light": "#0f0d0b",
    "dark": "#0f0d0b"
  },
  "--dsw-static-red-100": {
    "light": "#f0d6d7",
    "dark": "#f0d6d7"
  },
  "--dsw-static-red-400": {
    "light": "#c93a3a",
    "dark": "#c93a3a"
  },
  "--dsw-static-red-50": {
    "light": "#f7e9ea",
    "dark": "#f7e9ea"
  },
  "--dsw-static-red-500": {
    "light": "#a82424",
    "dark": "#a82424"
  },
  "--dsw-static-red-600": {
    "light": "#8a1c1c",
    "dark": "#8a1c1c"
  },
  "--dsw-static-red-900": {
    "light": "#3f1a1a",
    "dark": "#3f1a1a"
  },
  "--json-tree-hover": {
    "light": "#e9e4df",
    "dark": "#e9e4df"
  },
  "--json-tree-icon": {
    "light": "#6a6159",
    "dark": "#6a6159"
  },
  "--json-tree-keyword": {
    "light": "#9c8149",
    "dark": "#9c8149"
  },
  "--json-tree-number": {
    "light": "#8f1616",
    "dark": "#8f1616"
  },
  "--json-tree-property": {
    "light": "#5e6572",
    "dark": "#5e6572"
  },
  "--json-tree-punctuation": {
    "light": "#877d74",
    "dark": "#877d74"
  },
  "--json-tree-string": {
    "light": "#46734f",
    "dark": "#46734f"
  },
  "--shiki-background": {
    "light": "#ffffff",
    "dark": "#ffffff"
  },
  "--shiki-foreground": {
    "light": "#241f22",
    "dark": "#241f22"
  },
  "--shiki-token-comment": {
    "light": "#877d74",
    "dark": "#877d74"
  },
  "--shiki-token-constant": {
    "light": "#7a1212",
    "dark": "#7a1212"
  },
  "--shiki-token-function": {
    "light": "#5b4a9e",
    "dark": "#5b4a9e"
  },
  "--shiki-token-keyword": {
    "light": "#a82424",
    "dark": "#a82424"
  },
  "--shiki-token-link": {
    "light": "#5e6572",
    "dark": "#5e6572"
  },
  "--shiki-token-parameter": {
    "light": "#b52525",
    "dark": "#b52525"
  },
  "--shiki-token-punctuation": {
    "light": "#6a6159",
    "dark": "#6a6159"
  },
  "--shiki-token-string": {
    "light": "#3e6b47",
    "dark": "#3e6b47"
  },
  "--shiki-token-string-expression": {
    "light": "#46734f",
    "dark": "#46734f"
  }
}
