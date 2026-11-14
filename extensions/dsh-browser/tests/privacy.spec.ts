// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { isSensitiveField, maskValue } from '../src/content/privacy.ts'

describe('isSensitiveField', () => {
  it('flags password inputs', () => {
    const input = document.createElement('input')
    input.type = 'password'
    expect(isSensitiveField(input)).toBe(true)
  })

  it('flags credit-card autocomplete fields', () => {
    const input = document.createElement('input')
    input.autocomplete = 'cc-number'
    expect(isSensitiveField(input)).toBe(true)
    const credit = document.createElement('input')
    ;(credit as { autocomplete: string }).autocomplete = 'credit-card'
    expect(isSensitiveField(credit)).toBe(true)
  })

  it('flags fields named like secrets', () => {
    for (const id of ['password', 'cardNumber', 'cvv2', 'credit_card', 'token_secret']) {
      const input = document.createElement('input')
      input.id = id
      expect(isSensitiveField(input)).toBe(true)
    }
  })

  it('flags one-time codes, PINs, SSNs, IBANs, and API keys or tokens', () => {
    const otp = document.createElement('input')
    otp.autocomplete = 'one-time-code'
    expect(isSensitiveField(otp)).toBe(true)
    for (const name of ['otp', 'login_otp', 'oneTimeCode', 'one-time-password', 'pin', 'card_pin', 'pinCode', 'ssn',
      'social-security-number', 'iban', 'apiKey', 'api_key', 'access_token', 'authToken', 'mfa_code', '2fa']) {
      const input = document.createElement('input')
      input.name = name
      expect(isSensitiveField(input), name).toBe(true)
    }
    const placeholder = document.createElement('input')
    placeholder.placeholder = 'Enter your PIN'
    expect(isSensitiveField(placeholder)).toBe(true)
  })

  it('applies the same patterns to contenteditable hosts and their descendants', () => {
    const host = document.createElement('div')
    host.setAttribute('contenteditable', 'true')
    host.setAttribute('aria-label', 'API token')
    const inner = document.createElement('span')
    host.append(inner)
    document.body.append(host)
    expect(isSensitiveField(host)).toBe(true)
    expect(isSensitiveField(inner)).toBe(true)
    const plain = document.createElement('div')
    plain.setAttribute('contenteditable', '')
    plain.setAttribute('aria-label', 'Message body')
    document.body.append(plain)
    expect(isSensitiveField(plain)).toBe(false)
    host.remove()
    plain.remove()
  })

  it('leaves ordinary fields alone', () => {
    const input = document.createElement('input')
    input.id = 'email'
    expect(isSensitiveField(input)).toBe(false)
    expect(isSensitiveField(document.createElement('textarea'))).toBe(false)
    for (const name of ['spinner', 'shipping', 'keyword', 'monkey', 'opinion', 'pinterest_url', 'tokenizer_mode', 'description']) {
      const field = document.createElement('input')
      field.name = name
      expect(isSensitiveField(field), name).toBe(false)
    }
  })
})

describe('maskValue', () => {
  it('masks non-empty values and keeps empty values empty', () => {
    expect(maskValue('hunter2')).toBe('••••')
    expect(maskValue('')).toBe('')
  })
})

describe('sensitivity latch and extended vocabulary', () => {
  it('keeps a field masked after it stops looking sensitive', () => {
    const input = document.createElement('input')
    input.type = 'password'
    expect(isSensitiveField(input)).toBe(true)
    input.type = 'text'
    input.removeAttribute('name')
    expect(isSensitiveField(input)).toBe(true)
    const named = document.createElement('input')
    named.name = 'otp'
    expect(isSensitiveField(named)).toBe(true)
    named.name = 'comment'
    named.autocomplete = 'off'
    expect(isSensitiveField(named)).toBe(true)
  })

  it('flags short credential names, recovery material, and non-English labels', () => {
    for (const label of [
      'pass', 'user_pass', 'pw', 'newPw', 'passphrase', 'privateKey', 'private_key', 'wallet seed', 'seed phrase',
      'mnemonic', 'recovery code', 'recoveryPhrase', 'security answer', 'securityQuestionAnswer',
      '密码', '请输入验证码', '口令', 'Contraseña', 'mot de passe', 'Passwort', 'Пароль',
    ]) {
      const input = document.createElement('input')
      input.setAttribute('aria-label', label)
      expect(isSensitiveField(input), label).toBe(true)
    }
  })

  it('does not flag look-alike words', () => {
    for (const label of ['passenger', 'compass', 'pwa install', 'seedling', 'bypass mode', 'search', 'email']) {
      const input = document.createElement('input')
      input.setAttribute('aria-label', label)
      expect(isSensitiveField(input), label).toBe(false)
    }
  })
})
