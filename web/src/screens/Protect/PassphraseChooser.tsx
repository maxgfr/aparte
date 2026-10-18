import { Copy, RefreshCw } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { copySecret } from '../../app/clipboard.ts'
import { useToast } from '../../app/toast.tsx'
import { cryptoRng } from '../../core/crypto/rng.ts'
import { generatePassphrase } from '../../core/passphrase/diceware.ts'
import { loadStrengthCheck, type Score, type StrengthCheck } from '../../core/passphrase/strength.ts'
import { effWordlist } from '../../core/passphrase/wordlist.ts'
import { useT } from '../../i18n/react.tsx'
import { Button } from '../../ui/components/Button.tsx'
import { Field } from '../../ui/components/Field.tsx'
import { Segmented } from '../../ui/components/Segmented.tsx'
import styles from './Protect.module.css'

type Mode = 'generated' | 'custom'

type Estimator =
  | { readonly state: 'idle' }
  | { readonly state: 'loading' }
  | { readonly state: 'ready'; readonly check: StrengthCheck }
  | { readonly state: 'failed' }

const STRENGTH_KEYS = [
  'vault.strength0',
  'vault.strength1',
  'vault.strength2',
  'vault.strength3',
  'vault.strength4',
] as const satisfies readonly `vault.strength${Score}`[]

function newWords(): string {
  return generatePassphrase(effWordlist(), cryptoRng())
}

export interface PassphraseChooserProps {
  /** Label of the passphrase being chosen (a first one, or a new one after recovery). */
  readonly label: string
  /** The chosen passphrase once it is acceptable, null while it is not. */
  readonly onChange: (passphrase: string | null) => void
  readonly disabled?: boolean
}

/**
 * Chooses a passphrase: six generated words by default (copy, regenerate), or the user's own, accepted only at a
 * zxcvbn score of 3 or more and when typed twice the same. The estimator loads on the first character typed.
 */
export function PassphraseChooser({ label, onChange, disabled = false }: PassphraseChooserProps) {
  const t = useT()
  const toast = useToast()
  const [mode, setMode] = useState<Mode>('generated')
  const [words, setWords] = useState(newWords)
  const [custom, setCustom] = useState('')
  const [confirm, setConfirm] = useState('')
  const [confirmLeft, setConfirmLeft] = useState(false)
  const [show, setShow] = useState(false)
  const [estimator, setEstimator] = useState<Estimator>({ state: 'idle' })
  const showId = useId()
  const meterId = useId()

  // The estimator is fetched only once the user starts typing a passphrase of their own.
  useEffect(() => {
    if (mode !== 'custom' || custom === '' || estimator.state !== 'idle') return
    setEstimator({ state: 'loading' })
    loadStrengthCheck().then(
      (check) => setEstimator({ state: 'ready', check }),
      () => setEstimator({ state: 'failed' }),
    )
  }, [mode, custom, estimator.state])

  const strength = estimator.state === 'ready' && custom !== '' ? estimator.check(custom) : null
  const matches = confirm === custom
  const chosen = mode === 'generated' ? words : strength?.acceptable && matches ? custom : null

  useEffect(() => onChange(chosen), [chosen, onChange])

  const copy = () => {
    // The copy is taken back from the clipboard after a short while, and on lock.
    copySecret(words).then(
      () => toast(t('vault.copied')),
      () => toast(t('vault.copyFailed')),
    )
  }

  let strengthText = ''
  if (custom !== '') {
    if (estimator.state === 'failed') strengthText = t('vault.strengthLoadFailed')
    else if (strength === null) strengthText = t('vault.strengthChecking')
    else strengthText = t(STRENGTH_KEYS[strength.score])
  }
  const tone = strength === null ? 'none' : strength.acceptable ? 'good' : strength.score === 2 ? 'fair' : 'weak'

  return (
    <div className={styles.chooser}>
      <Segmented
        label={t('vault.choiceLabel')}
        options={[
          { value: 'generated', label: t('vault.choiceGenerated') },
          { value: 'custom', label: t('vault.choiceCustom') },
        ]}
        value={mode}
        onChange={(m: Mode) => {
          setMode(m)
          // An estimator that failed to load gets another try when the user comes back to their own passphrase.
          if (estimator.state === 'failed') setEstimator({ state: 'idle' })
        }}
      />
      {mode === 'generated' ? (
        <div className={styles.generated}>
          <Field
            label={label}
            hint={t('vault.generatedHint')}
            value={words}
            readOnly
            autoComplete="new-password"
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
            disabled={disabled}
            onFocus={(e) => e.currentTarget.select()}
          />
          <div className={styles.row}>
            <Button icon={<Copy size={18} strokeWidth={1.75} aria-hidden="true" />} onClick={copy} disabled={disabled}>
              {t('vault.copy')}
            </Button>
            <Button
              variant="plain"
              icon={<RefreshCw size={18} strokeWidth={1.75} aria-hidden="true" />}
              onClick={() => setWords(newWords())}
              disabled={disabled}
            >
              {t('vault.regenerate')}
            </Button>
          </div>
        </div>
      ) : (
        <div className={styles.custom}>
          <Field
            label={label}
            hint={t('vault.customHint')}
            type={show ? 'text' : 'password'}
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            autoComplete="new-password"
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
            disabled={disabled}
            enterKeyHint="next"
          />
          <div className={styles.strength} data-tone={tone}>
            {/* Native meters cannot be styled alike across engines: the meter is for assistive tech, the bars for the eye. */}
            <label htmlFor={meterId} className="sr-only">
              {t('vault.strength')}
            </label>
            <meter
              id={meterId}
              className="sr-only"
              min={0}
              max={4}
              low={2}
              high={3}
              optimum={4}
              value={strength?.score ?? 0}
              aria-valuetext={strengthText || undefined}
            />
            <div className={styles.meter} aria-hidden="true">
              {[1, 2, 3, 4].map((n) => (
                <span key={n} className={styles.bar} data-on={strength !== null && strength.score >= n} />
              ))}
            </div>
            <p className={styles.strengthText} aria-live="polite">
              {strengthText}
              {strength !== null && !strength.acceptable && ` ${t('vault.strengthTooWeak')}`}
            </p>
          </div>
          <Field
            label={t('vault.confirmLabel')}
            type={show ? 'text' : 'password'}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            onBlur={() => setConfirmLeft(true)}
            error={
              confirm !== '' && !matches && (confirmLeft || confirm.length >= custom.length)
                ? t('vault.confirmMismatch')
                : undefined
            }
            autoComplete="new-password"
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
            disabled={disabled}
          />
          <label className={styles.check} htmlFor={showId}>
            <input id={showId} type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} />
            {t('vault.showPassphrase')}
          </label>
        </div>
      )}
    </div>
  )
}
