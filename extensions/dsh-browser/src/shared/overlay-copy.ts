/**
 * On-page overlay copy (English and Chinese), chosen by the background from the
 * panel's UI locale and sent with each overlay command so the content bundle
 * stays free of the panel's string tables.
 *
 * @module
 */

import type { OverlayCopy } from '../content/overlay.ts'

export const OVERLAY_COPY: Record<'en' | 'zh', OverlayCopy> = {
  en: {
    controlling: 'AI controlling',
    stop: 'Stop',
    stopHint: 'Stop the agent now (kill switch)',
    typing: 'typing…',
    takeoverTitle: 'You\'re in control',
    takeoverBody: 'The agent is paused. Resume when done.',
    resume: 'Resume',
  },
  zh: {
    controlling: 'AI 正在操作',
    stop: '停止',
    stopHint: '立即停止助手（紧急停止）',
    typing: '正在输入…',
    takeoverTitle: '由你接管',
    takeoverBody: '助手已暂停，完成后点击继续。',
    resume: '继续',
  },
}
