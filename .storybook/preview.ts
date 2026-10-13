import type { Preview } from '@storybook/svelte-vite'
import 'basecoat-css/basecoat'
import 'basecoat-css/combobox'
import 'basecoat-css/dropdown-menu'
import 'basecoat-css/select'
import 'basecoat-css/popover'
import '../src/webview/app.css'
import './preview.css'

// Storybook loads preview modules after DOMContentLoaded; start Basecoat explicitly.
const basecoat = (window as Window & { basecoat?: { start?: () => void; initAll?: () => void } }).basecoat
basecoat?.start?.()
basecoat?.initAll?.()

const preview: Preview = {
  parameters: {
    layout: 'fullscreen',
    controls: { expanded: true },
    options: { storySort: { order: ['Chat', 'Settings', 'Context'] } },
    viewport: {
      options: {
        narrow: { name: 'Sidebar 280px', styles: { width: '280px', height: '850px' }, type: 'desktop' },
        standard: { name: 'Sidebar 360px', styles: { width: '360px', height: '850px' }, type: 'desktop' },
        wide: { name: 'Sidebar 480px', styles: { width: '480px', height: '850px' }, type: 'desktop' },
      },
    },
  },
}

export default preview
