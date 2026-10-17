import { Link } from 'wouter'
import { paths } from '../../app/routes.ts'
import { useT } from '../../i18n/react.tsx'
import { buttonClass } from '../../ui/components/Button.tsx'
import { Screen } from '../../ui/shell/Screen.tsx'

/** Any hash that names no screen (an old bookmark, a typo): says so and leads back to the start. */
export default function NotFound() {
  const t = useT()
  return (
    <Screen title={t('shell.notFoundTitle')}>
      <p>{t('shell.notFoundBody')}</p>
      <p>
        <Link href={paths.welcome} className={buttonClass({ variant: 'primary' })}>
          {t('shell.notFoundHome')}
        </Link>
      </p>
    </Screen>
  )
}
