import { Check, ChevronDown } from 'lucide-react'
import { useId, useMemo, useState } from 'react'
import { Link } from 'wouter'
import { useKeyedProviders } from '../../app/chat.tsx'
import { type ModelChoice, needsKey, sameModel, useModelChoices } from '../../app/providers.tsx'
import { paths } from '../../app/routes.ts'
import type { Capabilities, Effort, ModelDescriptor, ProviderKind } from '../../core/contracts/ai.ts'
import type { ModelRef } from '../../core/contracts/workspace.ts'
import { formatNumber, formatUsd } from '../../i18n/format.ts'
import type { Key } from '../../i18n/index.ts'
import { useLocale, useT } from '../../i18n/react.tsx'
import { buttonClass } from '../components/Button.tsx'
import { Field } from '../components/Field.tsx'
import { Sheet } from '../components/Sheet.tsx'
import { cx } from '../cx.ts'
import styles from './Chat.module.css'
import { matches, queryWords } from './view.ts'

/**
 * The capability badges of a model: only what it accepts, in a fixed order. An in-browser model without function
 * calling says so ("No tools"): WebLLM runs tools on its Hermes builds only.
 */
export function CapabilityBadges({ capabilities, kind }: { capabilities: Capabilities; kind?: ProviderKind }) {
  const t = useT()
  const badges: Extract<Key, `chat.badge${string}` | 'local.badgeNoTools'>[] = []
  if (capabilities.vision) badges.push('chat.badgeVision')
  if (capabilities.pdf) badges.push('chat.badgePdf')
  if (capabilities.tools) badges.push('chat.badgeTools')
  else if (kind === 'webllm') badges.push('local.badgeNoTools')
  if (capabilities.reasoning) badges.push('chat.badgeReasoning')
  if (capabilities.webSearch !== null) badges.push('chat.badgeWeb')
  if (badges.length === 0) return null
  return (
    <span className={styles.badges}>
      {badges.map((key) => (
        <span key={key} className={styles.badge}>
          {t(key)}
        </span>
      ))}
    </span>
  )
}

const EFFORT_KEYS: Readonly<Record<Effort, Extract<Key, `chat.effort${string}`>>> = {
  none: 'chat.effortNone',
  minimal: 'chat.effortMinimal',
  low: 'chat.effortLow',
  medium: 'chat.effortMedium',
  high: 'chat.effortHigh',
  xhigh: 'chat.effortXhigh',
  max: 'chat.effortMax',
}

export function useEffortLabel(): (effort: Effort) => string {
  const t = useT()
  return (effort) => t(EFFORT_KEYS[effort])
}

/**
 * The effort selector: only the levels the model accepts; hidden for a model that takes none. A chip that opens a sheet
 * of radio buttons rather than a native <select>: WebKit builds a select's menu with inline styles, which the strict
 * policy (`style-src-attr 'none'`) refuses and reports.
 */
export function EffortSelect({
  model,
  value,
  onChange,
}: {
  model: ModelDescriptor | null
  value: Effort | null
  onChange: (effort: Effort) => void
}) {
  const t = useT()
  const label = useEffortLabel()
  const name = useId()
  const [open, setOpen] = useState(false)
  const levels = model?.capabilities.effort.levels ?? []
  if (levels.length === 0) return null
  return (
    <>
      <button
        type="button"
        className={styles.effortSelect}
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-label={value === null ? t('chat.effortLabel') : t('chat.effortUsed', { effort: label(value) })}
      >
        <span>{value === null ? t('chat.effortLabel') : label(value)}</span>
        <ChevronDown size={16} strokeWidth={2} aria-hidden="true" />
      </button>
      <Sheet open={open} title={t('chat.effortLabel')} onClose={() => setOpen(false)}>
        <fieldset className={styles.effortChoices}>
          <legend className="sr-only">{t('chat.effortLabel')}</legend>
          {levels.map((level) => (
            <label key={level} className={cx(styles.pickerRow, level === value && styles.pickerRowSelected)}>
              <span>{label(level)}</span>
              <input
                type="radio"
                name={name}
                value={level}
                checked={level === value}
                onChange={() => {
                  onChange(level)
                  setOpen(false)
                }}
              />
            </label>
          ))}
        </fieldset>
      </Sheet>
    </>
  )
}

function ModelDetails({ model }: { model: ModelDescriptor }) {
  const t = useT()
  const locale = useLocale()
  const c = model.capabilities
  return (
    <span className={styles.modelDetails}>
      <CapabilityBadges capabilities={c} kind={model.kind} />
      <span className={styles.caption}>
        {t('chat.contextWindow', { count: formatNumber(locale, c.contextWindow, 0) })}
        {c.cost !== null &&
          ` · ${t('chat.priceLine', { input: formatUsd(locale, c.cost.input), output: formatUsd(locale, c.cost.output) })}`}
      </span>
    </span>
  )
}

/** The model chip of the composer and the sheet it opens. */
export function ModelPicker({ value, onChange }: { value: ModelRef | null; onChange: (ref: ModelRef) => void }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const choices = useModelChoices()
  const keyed = useKeyedProviders()
  const current = choices.find((c) => sameModel(c.model.ref, value))

  const groups = useMemo(() => {
    const words = queryWords(query)
    const out = new Map<string, { label: string; items: ModelChoice[] }>()
    for (const choice of choices) {
      if (!matches(`${choice.provider.label} ${choice.model.name} ${choice.model.ref.id}`, words)) continue
      const group = out.get(choice.provider.id) ?? { label: choice.provider.label, items: [] }
      group.items.push(choice)
      out.set(choice.provider.id, group)
    }
    return [...out.entries()]
  }, [choices, query])

  return (
    <>
      <button
        type="button"
        className={styles.modelChip}
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-label={t('chat.modelChipLabel', { model: current?.model.name ?? value?.id ?? t('chat.modelPick') })}
      >
        <span className={styles.modelChipName}>{current?.model.name ?? value?.id ?? t('chat.modelPick')}</span>
        <ChevronDown size={16} strokeWidth={2} aria-hidden="true" />
      </button>
      <Sheet open={open} title={t('chat.modelPick')} onClose={() => setOpen(false)}>
        <div className={styles.picker}>
          <Field
            label={t('chat.modelSearch')}
            hideLabel
            type="search"
            placeholder={t('chat.modelSearch')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          {groups.length === 0 && <p className={styles.muted}>{t('chat.modelNone')}</p>}
          {groups.map(([id, group]) => (
            <section key={id} className={styles.pickerGroup} aria-label={group.label}>
              <h3 className={styles.pickerGroupTitle}>{group.label}</h3>
              <ul className={styles.pickerList}>
                {group.items.map((choice) => {
                  const selected = sameModel(choice.model.ref, value)
                  const missingKey = needsKey(choice.provider) && keyed !== null && !keyed.has(choice.provider.id)
                  return (
                    <li key={choice.model.ref.id}>
                      <button
                        type="button"
                        className={cx(styles.pickerRow, selected && styles.pickerRowSelected)}
                        aria-pressed={selected}
                        onClick={() => {
                          onChange(choice.model.ref)
                          setOpen(false)
                        }}
                      >
                        <span className={styles.pickerText}>
                          <span className={styles.modelId}>{choice.model.name}</span>
                          {missingKey && <span className={styles.warningText}>{t('chat.modelKeyMissing')}</span>}
                          <ModelDetails model={choice.model} />
                        </span>
                        {selected && <Check size={18} strokeWidth={2} aria-hidden="true" />}
                      </button>
                    </li>
                  )
                })}
              </ul>
            </section>
          ))}
          <Link href={paths.providers} className={buttonClass({ variant: 'plain' })} onClick={() => setOpen(false)}>
            {t('chat.modelManage')}
          </Link>
        </div>
      </Sheet>
    </>
  )
}
