// 由 scripts/derive-skins.mjs 生成，勿手改；源 = dsh-miasaki-desktop/themes/zafkiel.skin.css
// 语义见 design/2026-09-12-appearance-m2-design.md §2：{light,dark} 同值对（static 明度中立，
// 明暗语义由官方 alias 端点选择承载；body inline 覆盖 static 可回溯 alias，§1.2 实机已证）。
export const name = "zafkiel"

export const meta = {
  "id": "zafkiel",
  "label": "刻刻帝",
  "preferredScheme": "dark"
}

export const tokens = {
  "--dsh-scrollbar-thumb": {
    "light": "#4a4157",
    "dark": "#4a4157"
  },
  "--dsh-scrollbar-thumb-hover": {
    "light": "#6a5e7a",
    "dark": "#6a5e7a"
  },
  "--dsh-state-ongoing": {
    "light": "#c23a2e",
    "dark": "#c23a2e"
  },
  "--dsl-code-block-banner-background-color": {
    "light": "#171420",
    "dark": "#171420"
  },
  "--dsw-alias-bg-base": {
    "light": "rgba(12, 11, 17, .8)",
    "dark": "rgba(12, 11, 17, .8)"
  },
  "--dsw-alias-bg-layer-1": {
    "light": "rgba(30, 26, 39, .9)",
    "dark": "rgba(30, 26, 39, .9)"
  },
  "--dsw-alias-bg-layer-2": {
    "light": "rgba(38, 32, 48, .92)",
    "dark": "rgba(38, 32, 48, .92)"
  },
  "--dsw-alias-bg-module-platform": {
    "light": "rgba(30, 26, 39, .9)",
    "dark": "rgba(30, 26, 39, .9)"
  },
  "--dsw-alias-bg-overlay": {
    "light": "rgba(24, 20, 32, .96)",
    "dark": "rgba(24, 20, 32, .96)"
  },
  "--dsw-alias-brand-primary-new-colorprimary-new-color": {
    "light": "#c23a2e",
    "dark": "#c23a2e"
  },
  "--dsw-hovercard-bg": {
    "light": "#1e1a27",
    "dark": "#1e1a27"
  },
  "--dsw-linear-gradient-think": {
    "light": "linear-gradient(180deg, #121019 20.19%, rgba(18, 16, 25, 0) 100%)",
    "dark": "linear-gradient(180deg, #121019 20.19%, rgba(18, 16, 25, 0) 100%)"
  },
  "--dsw-linear-think-select": {
    "light": "linear-gradient(180deg, #1e1a27 20.19%, rgba(30, 26, 39, 0) 100%)",
    "dark": "linear-gradient(180deg, #1e1a27 20.19%, rgba(30, 26, 39, 0) 100%)"
  },
  "--dsw-specific-sidebar-fill": {
    "light": "rgba(18, 16, 25, .8)",
    "dark": "rgba(18, 16, 25, .8)"
  },
  "--dsw-static-amber-100": {
    "light": "#efe3c4",
    "dark": "#efe3c4"
  },
  "--dsw-static-amber-400": {
    "light": "#d9b36a",
    "dark": "#d9b36a"
  },
  "--dsw-static-amber-500": {
    "light": "#c9a25a",
    "dark": "#c9a25a"
  },
  "--dsw-static-amber-600": {
    "light": "#a98944",
    "dark": "#a98944"
  },
  "--dsw-static-amber-900": {
    "light": "#4a3e22",
    "dark": "#4a3e22"
  },
  "--dsw-static-blue-100": {
    "light": "#dce2eb",
    "dark": "#dce2eb"
  },
  "--dsw-static-blue-300": {
    "light": "#a9b4c8",
    "dark": "#a9b4c8"
  },
  "--dsw-static-blue-400": {
    "light": "#7d96c9",
    "dark": "#7d96c9"
  },
  "--dsw-static-blue-450": {
    "light": "#6d86bc",
    "dark": "#6d86bc"
  },
  "--dsw-static-blue-50": {
    "light": "#edf0f5",
    "dark": "#edf0f5"
  },
  "--dsw-static-blue-500": {
    "light": "#61799f",
    "dark": "#61799f"
  },
  "--dsw-static-blue-50p": {
    "light": "#e9edf3",
    "dark": "#e9edf3"
  },
  "--dsw-static-blue-600": {
    "light": "#4e6484",
    "dark": "#4e6484"
  },
  "--dsw-static-blue-75": {
    "light": "#e3e8ef",
    "dark": "#e3e8ef"
  },
  "--dsw-static-blue-800": {
    "light": "#34425a",
    "dark": "#34425a"
  },
  "--dsw-static-blue-900": {
    "light": "#262e3e",
    "dark": "#262e3e"
  },
  "--dsw-static-blue-950": {
    "light": "#1b2130",
    "dark": "#1b2130"
  },
  "--dsw-static-deepseek-100": {
    "light": "#f2dfdc",
    "dark": "#f2dfdc"
  },
  "--dsw-static-deepseek-200": {
    "light": "#eacfca",
    "dark": "#eacfca"
  },
  "--dsw-static-deepseek-300": {
    "light": "#dfb4ae",
    "dark": "#dfb4ae"
  },
  "--dsw-static-deepseek-400": {
    "light": "#d44a3c",
    "dark": "#d44a3c"
  },
  "--dsw-static-deepseek-450": {
    "light": "#c23a2e",
    "dark": "#c23a2e"
  },
  "--dsw-static-deepseek-50": {
    "light": "#f9edeb",
    "dark": "#f9edeb"
  },
  "--dsw-static-deepseek-500": {
    "light": "#b3362c",
    "dark": "#b3362c"
  },
  "--dsw-static-deepseek-600": {
    "light": "#9a2f26",
    "dark": "#9a2f26"
  },
  "--dsw-static-deepseek-700-delete": {
    "light": "#7c2b24",
    "dark": "#7c2b24"
  },
  "--dsw-static-deepseek-800": {
    "light": "#5a2b28",
    "dark": "#5a2b28"
  },
  "--dsw-static-deepseek-900": {
    "light": "#3a2122",
    "dark": "#3a2122"
  },
  "--dsw-static-green-100": {
    "light": "#d9e5d8",
    "dark": "#d9e5d8"
  },
  "--dsw-static-green-400": {
    "light": "#6fa77c",
    "dark": "#6fa77c"
  },
  "--dsw-static-green-500": {
    "light": "#55895f",
    "dark": "#55895f"
  },
  "--dsw-static-green-900": {
    "light": "#24382a",
    "dark": "#24382a"
  },
  "--dsw-static-neutral-00": {
    "light": "#faf7fc",
    "dark": "#faf7fc"
  },
  "--dsw-static-neutral-100": {
    "light": "#e4def0",
    "dark": "#e4def0"
  },
  "--dsw-static-neutral-1000": {
    "light": "#080709",
    "dark": "#080709"
  },
  "--dsw-static-neutral-150": {
    "light": "#d6cfe4",
    "dark": "#d6cfe4"
  },
  "--dsw-static-neutral-200": {
    "light": "#c2b8d4",
    "dark": "#c2b8d4"
  },
  "--dsw-static-neutral-250": {
    "light": "#b1a6c5",
    "dark": "#b1a6c5"
  },
  "--dsw-static-neutral-300": {
    "light": "#9a8fa8",
    "dark": "#9a8fa8"
  },
  "--dsw-static-neutral-400": {
    "light": "#7c7089",
    "dark": "#7c7089"
  },
  "--dsw-static-neutral-50": {
    "light": "#f1edf6",
    "dark": "#f1edf6"
  },
  "--dsw-static-neutral-500": {
    "light": "#5f5568",
    "dark": "#5f5568"
  },
  "--dsw-static-neutral-550": {
    "light": "#554b5e",
    "dark": "#554b5e"
  },
  "--dsw-static-neutral-600": {
    "light": "#4b4254",
    "dark": "#4b4254"
  },
  "--dsw-static-neutral-700": {
    "light": "#3a3243",
    "dark": "#3a3243"
  },
  "--dsw-static-neutral-800": {
    "light": "#262030",
    "dark": "#262030"
  },
  "--dsw-static-neutral-850": {
    "light": "#1e1a27",
    "dark": "#1e1a27"
  },
  "--dsw-static-neutral-900": {
    "light": "#121019",
    "dark": "#121019"
  },
  "--dsw-static-neutral-bluish-00": {
    "light": "#faf7fc",
    "dark": "#faf7fc"
  },
  "--dsw-static-neutral-bluish-100": {
    "light": "#e4def0",
    "dark": "#e4def0"
  },
  "--dsw-static-neutral-bluish-1000": {
    "light": "#080709",
    "dark": "#080709"
  },
  "--dsw-static-neutral-bluish-150": {
    "light": "#d6cfe4",
    "dark": "#d6cfe4"
  },
  "--dsw-static-neutral-bluish-200": {
    "light": "#c2b8d4",
    "dark": "#c2b8d4"
  },
  "--dsw-static-neutral-bluish-300": {
    "light": "#9a8fa8",
    "dark": "#9a8fa8"
  },
  "--dsw-static-neutral-bluish-400": {
    "light": "#7c7089",
    "dark": "#7c7089"
  },
  "--dsw-static-neutral-bluish-50": {
    "light": "#f1edf6",
    "dark": "#f1edf6"
  },
  "--dsw-static-neutral-bluish-500": {
    "light": "#5f5568",
    "dark": "#5f5568"
  },
  "--dsw-static-neutral-bluish-60": {
    "light": "#ece8f2",
    "dark": "#ece8f2"
  },
  "--dsw-static-neutral-bluish-600": {
    "light": "#4b4254",
    "dark": "#4b4254"
  },
  "--dsw-static-neutral-bluish-700": {
    "light": "#3a3243",
    "dark": "#3a3243"
  },
  "--dsw-static-neutral-bluish-75": {
    "light": "#e2deea",
    "dark": "#e2deea"
  },
  "--dsw-static-neutral-bluish-750": {
    "light": "#2f2836",
    "dark": "#2f2836"
  },
  "--dsw-static-neutral-bluish-800": {
    "light": "#262030",
    "dark": "#262030"
  },
  "--dsw-static-neutral-bluish-850": {
    "light": "#1e1a27",
    "dark": "#1e1a27"
  },
  "--dsw-static-neutral-bluish-875": {
    "light": "#171420",
    "dark": "#171420"
  },
  "--dsw-static-neutral-bluish-900": {
    "light": "#121019",
    "dark": "#121019"
  },
  "--dsw-static-neutral-bluish-950": {
    "light": "#0c0b11",
    "dark": "#0c0b11"
  },
  "--dsw-static-red-100": {
    "light": "#f1dad7",
    "dark": "#f1dad7"
  },
  "--dsw-static-red-400": {
    "light": "#e06a5c",
    "dark": "#e06a5c"
  },
  "--dsw-static-red-50": {
    "light": "#f9ecea",
    "dark": "#f9ecea"
  },
  "--dsw-static-red-500": {
    "light": "#d04e41",
    "dark": "#d04e41"
  },
  "--dsw-static-red-600": {
    "light": "#b73e33",
    "dark": "#b73e33"
  },
  "--dsw-static-red-900": {
    "light": "#4a2320",
    "dark": "#4a2320"
  },
  "--json-tree-hover": {
    "light": "#2a2434",
    "dark": "#2a2434"
  },
  "--json-tree-icon": {
    "light": "#9a8fa8",
    "dark": "#9a8fa8"
  },
  "--json-tree-keyword": {
    "light": "#d44a3c",
    "dark": "#d44a3c"
  },
  "--json-tree-number": {
    "light": "#d9b36a",
    "dark": "#d9b36a"
  },
  "--json-tree-property": {
    "light": "#b8aec4",
    "dark": "#b8aec4"
  },
  "--json-tree-punctuation": {
    "light": "#6a6278",
    "dark": "#6a6278"
  },
  "--json-tree-string": {
    "light": "#8fbf9c",
    "dark": "#8fbf9c"
  },
  "--shiki-background": {
    "light": "#121019",
    "dark": "#121019"
  },
  "--shiki-foreground": {
    "light": "#e4def0",
    "dark": "#e4def0"
  },
  "--shiki-token-comment": {
    "light": "#7c7089",
    "dark": "#7c7089"
  },
  "--shiki-token-constant": {
    "light": "#d9a94f",
    "dark": "#d9a94f"
  },
  "--shiki-token-function": {
    "light": "#c2a3e8",
    "dark": "#c2a3e8"
  },
  "--shiki-token-keyword": {
    "light": "#e06a5c",
    "dark": "#e06a5c"
  },
  "--shiki-token-link": {
    "light": "#7d96c9",
    "dark": "#7d96c9"
  },
  "--shiki-token-parameter": {
    "light": "#dfb4ae",
    "dark": "#dfb4ae"
  },
  "--shiki-token-punctuation": {
    "light": "#9a8fa8",
    "dark": "#9a8fa8"
  },
  "--shiki-token-string": {
    "light": "#7fbf8f",
    "dark": "#7fbf8f"
  },
  "--shiki-token-string-expression": {
    "light": "#8fbf9c",
    "dark": "#8fbf9c"
  }
}
