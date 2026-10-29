/** Scoped styles using Harness theme variables. */
export const css = `
.cgs{max-width:620px;color:var(--dsw-alias-label-primary,#202124);font-size:14px;line-height:1.5;padding:4px 0}
.cgs h2{display:flex;align-items:center;gap:10px;font-size:20px;font-weight:600;line-height:28px;margin:0}
.cgs h2 .cgs-logo{width:28px;height:28px;flex-shrink:0}
.cgs h3{margin:0;font-size:14px;font-weight:500;line-height:20px}
.cgs p{margin:0}
.cgs-header{display:flex;flex-direction:column;gap:6px;margin-bottom:20px}
.cgs-header>p{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary,#65676b)}
.cgs-loading{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary,#65676b)}
.cgs-card{position:relative;display:flex;flex-direction:column;gap:12px;margin:0 0 12px;padding:14px 16px;border:.5px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l4,#e1e2e5));border-radius:var(--dsw-radius-xl,20px);background:var(--dsw-alias-settings-card-fill,var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-layer-1,#f7f7f7)))}
.cgs-card:last-child{margin-bottom:0}
.cgs-card>button,.cgs-card>.cgs-button{align-self:flex-start}
.cgs-card-head{display:flex;align-items:center;gap:8px;min-height:20px}
.cgs-card-head h3{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-primary,#202124)}
.cgs-section-icon{flex:none;color:var(--dsw-alias-label-secondary,#65676b)}
.cgs-note{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#65676b);overflow-wrap:anywhere}
.cgs-account-line{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;position:relative}
.cgs-current{display:grid;gap:6px;min-width:0;overflow-wrap:anywhere}
.cgs-current b{font-weight:500;font-size:15px;line-height:22px}
.cgs-status{display:inline-flex;align-items:center;gap:6px;width:fit-content;padding:1px 8px;border:.5px solid var(--dsw-alias-border-l3,#d5d6d9);border-radius:999px;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-secondary,#65676b);font-size:11px;line-height:16px}
.cgs-status:before{content:"";flex:none;width:5px;height:5px;border-radius:50%;background:currentColor}
.cgs-status.is-connected{color:var(--dsw-alias-state-success-primary,#398268)}
.cgs summary{cursor:pointer;list-style:none}
.cgs summary::-webkit-details-marker{display:none}
.cgs-summary-chevron{width:12px;height:12px;flex:none;color:var(--dsw-alias-label-secondary,#65676b);transition:transform .12s ease}
.cgs details[open]>summary .cgs-summary-chevron{transform:rotate(180deg)}
.cgs-account-menu>summary{display:inline-flex;align-items:center;gap:6px;box-sizing:border-box;height:32px;white-space:nowrap;padding:0 10px 0 12px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary,#202124);background:transparent;border:.5px solid var(--dsw-alias-border-l3,#d5d6d9);border-radius:var(--dsw-radius-md,8px)}
.cgs-account-menu>summary:hover,.cgs-account-menu[open]>summary{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04))}
.cgs-account-controls{position:absolute;z-index:2;right:0;top:calc(100% + 6px);display:flex;flex-direction:column;gap:10px;width:min(340px,100%);box-sizing:border-box;padding:14px;border:.5px solid var(--dsw-elevation-stroke-color,var(--dsw-alias-border-l2,#ddd));border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-bg-base,#fff);box-shadow:var(--dsw-elevation-prominent,0 3px 8px rgba(0,0,0,.04),0 0 20px rgba(0,0,0,.05))}
.cgs-label{display:grid;gap:6px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#65676b)}
.cgs select{box-sizing:border-box;width:100%;min-width:0;height:32px;padding:0 32px 0 10px;font:inherit;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary,#202124);border:.5px solid var(--dsw-alias-border-l4,#d5d6d9);border-radius:var(--dsw-radius-md,8px);background-color:var(--dsw-alias-bg-layer-1,#f7f7f7);appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' stroke='%2381858C' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");background-position:right 12px center;background-repeat:no-repeat;background-size:12px 12px;cursor:pointer}
.cgs select:hover:not(:disabled){border-color:var(--dsw-alias-border-l3,#c7c9cc)}
.cgs select:disabled{opacity:.6;cursor:default}
.cgs-plan{display:flex;align-items:center;justify-content:space-between;gap:16px;font-size:13px;line-height:20px}
.cgs-plan>span{color:var(--dsw-alias-label-secondary,#65676b)}
.cgs-plan a{color:var(--dsw-alias-label-primary,#202124);text-decoration:none;text-underline-offset:3px}
.cgs-plan a:hover{text-decoration:underline}
.cgs-search{gap:10px}
.cgs-search-row{display:flex;align-items:center;justify-content:space-between;gap:16px}
.cgs-search-label{display:flex;align-items:center;gap:8px;font-size:14px;font-weight:500;line-height:22px}
.cgs-search-row select{width:240px;max-width:60%;font-size:13px}
.cgs-network{padding:0;gap:0}
.cgs-network>summary{display:flex;align-items:center;gap:8px;padding:14px 16px;font-size:14px;font-weight:500;line-height:20px;color:var(--dsw-alias-label-primary,#202124)}
.cgs-network-chevron{margin-left:auto}
.cgs-network-body{display:grid;gap:6px;padding:0 16px 14px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#65676b)}
.cgs-network-body p{margin:0}
.cgs-network-body code{width:fit-content;max-width:100%;padding:2px 6px;border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-bg-base,#fff);overflow-wrap:anywhere}
.cgs-actions,.cgs-pending{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.cgs-pending{padding:12px;border:.5px solid var(--dsw-alias-border-l2,#e5e5e5);border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-bg-base,#fff)}
.cgs-pending p{width:100%;margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#65676b)}
.cgs button,.cgs-button{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;height:32px;border:.5px solid var(--dsw-alias-border-l3,#d5d6d9);border-radius:var(--dsw-radius-md,8px);padding:0 12px;font:inherit;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary,#202124);background:transparent;cursor:pointer;text-decoration:none}
.cgs button:hover,.cgs-button:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04))}
.cgs .cgs-primary{background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-label-primary,#202124));color:var(--dsw-alias-label-primary-foreground,var(--dsw-alias-bg-base,#fff));border-color:transparent}
.cgs .cgs-primary:hover{background:var(--dsw-alias-button-primary-hover,var(--dsw-alias-label-primary,#202124))}
.cgs button:disabled{opacity:.4;cursor:default}
.cgs :is(button,a,select,summary):focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#3663d9))}
.cgs a{color:inherit;text-underline-offset:3px}
.cgs-notice{margin:0 0 12px;padding:10px 12px;border:.5px solid var(--dsw-alias-border-l2,#e5e5e5);border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-bg-layer-1,#f7f7f7);font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#65676b)}
.cgs-error{margin:12px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary,#b42318)}
.cgs-welcome{width:min(420px,calc(100vw - 64px));color:inherit;border:.5px solid var(--dsw-elevation-stroke-color,var(--dsw-alias-border-l2,#ccc));border-radius:var(--dsw-radius-lg,12px);padding:24px;background:var(--dsw-alias-bg-base,#fff);box-shadow:var(--dsw-elevation-prominent,0 3px 8px rgba(0,0,0,.04),0 0 20px rgba(0,0,0,.05))}
.cgs-welcome::backdrop{background:rgba(0,0,0,.35)}
.cgs-welcome p{margin:8px 0 12px}
.cgs-welcome button{margin-left:14px}
@media(max-width:480px){.cgs{padding:2px 0}
.cgs-card{padding:12px 14px}
.cgs-search-row{align-items:stretch;flex-direction:column;gap:10px}
.cgs-search-row select{width:100%;max-width:none}
.cgs-network>summary{padding:12px 14px}
.cgs-network-body{padding:0 14px 12px}
.cgs button,.cgs-button{height:36px}}
`

/** Compact connection card rendered in the Models provider directory. */
export const providerCss = `
.cgs-provider{display:flex;flex-direction:column;gap:8px;color:var(--dsw-alias-label-primary,#202124);font-size:13px;line-height:20px}
.cgs-provider-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.cgs-provider-row span{min-width:0;overflow-wrap:anywhere}
.cgs-provider-row button,.cgs-provider-primary{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;height:28px;border:.5px solid var(--dsw-alias-border-l3,#d5d6d9);border-radius:var(--dsw-radius-md,8px);padding:0 10px;font:inherit;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary,#202124);background:transparent;cursor:pointer}
.cgs-provider-row button:hover,.cgs-provider-primary:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04))}
.cgs-provider-row button:disabled{opacity:.4;cursor:default}
.cgs-provider-primary{background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-label-primary,#202124));border-color:transparent;color:var(--dsw-alias-label-primary-foreground,var(--dsw-alias-bg-base,#fff))}
.cgs-provider-primary:hover{background:var(--dsw-alias-button-primary-hover,var(--dsw-alias-label-primary,#202124))}
.cgs-provider-connected{color:var(--dsw-alias-state-success-primary,#398268)}
.cgs-provider-link{color:inherit;text-underline-offset:3px}
.cgs-provider-note{margin:0;color:var(--dsw-alias-label-secondary,#65676b);font-size:12px;line-height:18px}
.cgs-provider-error{margin:0;color:var(--dsw-alias-state-error-primary,#b42318);font-size:12px;line-height:18px}
.cgs-provider :is(button,a):focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#3663d9))}
`
