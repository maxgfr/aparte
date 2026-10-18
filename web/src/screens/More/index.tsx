import { ArrowLeftRight, BarChart3, BookOpen, Info, Swords, Theater } from 'lucide-react'
import { paths } from '../../app/routes.ts'
import { useT } from '../../i18n/react.tsx'
import { ListGroup, ListRow } from '../../ui/components/List.tsx'
import { Screen } from '../../ui/shell/Screen.tsx'

/** The screens that do not fit the tab bar, in groups. */
export default function MoreScreen() {
  const t = useT()
  const icon = { size: 20, strokeWidth: 1.75, 'aria-hidden': true } as const
  return (
    <Screen title={t('shell.moreTitle')}>
      <ListGroup title={t('shell.moreCompare')}>
        <ListRow
          href={paths.arena}
          leading={<Swords {...icon} />}
          title={t('shell.moreArena')}
          subtitle={t('shell.moreArenaHint')}
        />
      </ListGroup>
      <ListGroup title={t('shell.moreRoleplay')}>
        <ListRow
          href={paths.characters}
          leading={<Theater {...icon} />}
          title={t('shell.moreCharacters')}
          subtitle={t('shell.moreCharactersHint')}
        />
      </ListGroup>
      <ListGroup title={t('shell.moreData')}>
        <ListRow
          href={paths.knowledge}
          leading={<BookOpen {...icon} />}
          title={t('knowledge.navKnowledge')}
          subtitle={t('knowledge.moreHint')}
        />
        <ListRow
          href={paths.transfer}
          leading={<ArrowLeftRight {...icon} />}
          title={t('shell.moreTransfer')}
          subtitle={t('shell.moreTransferHint')}
        />
        <ListRow
          href={paths.stats}
          leading={<BarChart3 {...icon} />}
          title={t('shell.moreStats')}
          subtitle={t('shell.moreStatsHint')}
        />
      </ListGroup>
      <ListGroup title={t('shell.moreApp')}>
        <ListRow href={paths.about} leading={<Info {...icon} />} title={t('shell.moreAbout')} />
      </ListGroup>
    </Screen>
  )
}
