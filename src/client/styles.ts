/** Scoped styles using Harness theme variables. */
export const css = `
.cgs{max-width:620px;color:var(--dsw-alias-label-primary,#202124);font-size:14px;line-height:1.5;padding:8px 0}
.cgs h2{display:flex;align-items:center;gap:10px;font-size:20px;font-weight:600;margin:0}
.cgs h2 .cgs-logo{width:28px;height:28px;flex-shrink:0}
.cgs h3{font-size:14px;font-weight:600;margin:0}
.cgs p{margin:8px 0 12px}
.cgs header{margin-bottom:24px}
.cgs header>p,.cgs-note,.cgs-current small{color:var(--dsw-alias-label-secondary,#65676b)}
.cgs header>p{margin:6px 0 0;font-size:13px}
.cgs-note{font-size:12px;overflow-wrap:anywhere}
.cgs-group-heading{display:flex;align-items:center;gap:8px;padding:0 0 16px}
.cgs-section-icon{flex:none;color:var(--dsw-alias-label-secondary,#65676b)}
.cgs-account{padding:0 0 20px}
.cgs-account-line{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;position:relative}
.cgs-current{display:grid;gap:3px;min-width:0;overflow-wrap:anywhere}
.cgs-current small{font-size:12px}
.cgs-current b{font-weight:500;font-size:14px}
.cgs summary{cursor:pointer;list-style:none;font-size:12px;color:var(--dsw-alias-label-secondary,#65676b)}
.cgs summary::-webkit-details-marker{display:none}
.cgs summary:after{content:'⌄';margin-left:6px;display:inline-block}
.cgs details[open]>summary:after{transform:rotate(180deg)}
.cgs-account-menu>summary{white-space:nowrap;padding:8px 12px;border-radius:8px;font-size:13px;background:var(--dsw-alias-bg-module-platform,var(--dsw-alias-bg-layer-1,#f5f6f7));color:var(--dsw-alias-label-primary,#202124)}
.cgs-status{display:flex;align-items:center;gap:6px}
.cgs-status:before{content:"";width:5px;height:5px;border-radius:50%;background:currentColor}
.cgs-status.is-connected:before{background:var(--dsw-alias-state-success-primary,#398268)}
.cgs-account-controls{position:absolute;z-index:2;right:0;top:42px;width:min(340px,100%);box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1,#ddd);border-radius:10px;padding:16px;background:var(--dsw-alias-bg-base,#fff);box-shadow:0 6px 24px #00000012}
.cgs-label{display:grid;gap:6px;font-size:12px}
.cgs select{width:100%;min-width:0;padding:8px;font:inherit;border:1px solid var(--dsw-alias-border-l2,#ccc);border-radius:6px;background:var(--dsw-alias-bg-base,#fff);color:inherit}
.cgs-plan{display:flex;align-items:center;justify-content:space-between;gap:16px;font-size:14px}
.cgs-plan a{text-decoration:none}
.cgs-plan a:hover{text-decoration:underline}
.cgs-plan-section{padding:20px 0;border-top:.5px solid var(--dsw-alias-border-l2,#e5e5e5)}
.cgs-network>summary{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-primary,#202124);font-size:14px;font-weight:600}
.cgs-network>summary:after{margin-left:auto}
.cgs-network{border-top:.5px solid var(--dsw-alias-border-l1,#e5e5e5);padding-top:16px;font-size:12px;color:var(--dsw-alias-label-secondary,#65676b)}
.cgs-network p:first-of-type{margin-top:14px}
.cgs code{overflow-wrap:anywhere}
.cgs-actions,.cgs-pending{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.cgs-pending{margin-top:16px}
.cgs-pending p{width:100%;margin:0 0 4px}
.cgs button,.cgs-button{font:inherit;font-size:12px;display:inline-flex;align-items:center;justify-content:center;min-height:32px;border:1px solid var(--dsw-alias-border-l2,#ddd);border-radius:6px;padding:6px 10px;color:inherit;background:var(--dsw-alias-bg-base,#fff);cursor:pointer;text-decoration:none}
.cgs .cgs-primary{background:var(--dsw-alias-label-primary,#202124);color:var(--dsw-alias-bg-base,#fff);border-color:transparent}
.cgs button:hover,.cgs-button:hover{filter:brightness(.94)}
.cgs button:disabled{opacity:.5;cursor:wait}
.cgs :is(button,a,select,summary):focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#3663d9);outline-offset:3px}
.cgs a{color:inherit;text-underline-offset:3px}
.cgs-error{color:var(--dsw-alias-state-error-primary,#b42318)}
.cgs-welcome{width:min(420px,calc(100vw - 64px));color:inherit;border:1px solid var(--dsw-alias-border-l2,#ccc);border-radius:10px;padding:24px;background:var(--dsw-alias-bg-layer-1,#f7f7f7)}
.cgs-welcome::backdrop{background:rgba(0,0,0,.35)}
.cgs-welcome button{margin-left:14px}
@media(max-width:480px){.cgs{padding:4px 0}
.cgs button{min-height:36px}}
`
