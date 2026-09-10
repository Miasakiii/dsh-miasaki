// Client half of @miasaki/dsh-ssh: registers the "SSH" conversation view
// (tab in the session header) and renders the SSH page in an isolated iframe.
// The iframe is a separate document so xterm.js can be loaded with plain
// <script> tags (the DSH client bundle cannot require third-party packages).
window.__ModuleLoader__.load({
  id: '@miasaki/dsh-ssh',
  factory: (require) => {
    const module = { exports: {} }
    const react = require('react')

    module.exports.inject = ['slots']

    module.exports.apply = ctx => {
      // Idempotence guard: DSH HMR / re-applies must not stack a second tab.
      if (window.__DSH_SSH_BOOTED__) return
      window.__DSH_SSH_BOOTED__ = true

      function SshView() {
        return react.createElement('iframe', {
          src: '/ssh/',
          title: 'SSH',
          // Fill the conversation view area; the iframe document owns all of
          // its own styling (layout, theme, fonts).
          style: {
            display: 'block',
            width: '100%',
            height: '100%',
            border: '0',
            background: '#0b0e14',
          },
        })
      }

      // The registered view is disposed by the slot system together with the
      // fiber (stop / update removes the tab and resets the guard).
      ctx.slots.inject(
        'conversation.view',
        () => ctx.slots.register({
          name: 'conversation.view',
          id: 'ssh',
          order: 20, // after token-monitor (15)
          label: () => 'SSH',
        }, SshView),
      )

      // Reset the idempotence guard when the fiber is torn down (HMR full
      // recycle / plugin reinstall), so the next apply can mount again.
      ctx.effect(() => () => { window.__DSH_SSH_BOOTED__ = false }, 'ssh: view')
    }

    return module.exports
  },
})