'use client';

import { useEffect, useId, useState, type KeyboardEvent } from 'react';
import { Clapperboard, Sparkles, UserRound } from 'lucide-react';
import CreativeStudio from './CreativeStudio';
import DigitalHumanWorkspace from './DigitalHumanWorkspace';
import MomentsMaterials from './MomentsMaterials';
import './marketing-materials.css';

const sections = [
  { id: 'creative', label: '创作与设计', Icon: Sparkles },
  { id: 'moments', label: 'AI 朋友圈', Icon: Clapperboard },
  { id: 'digitalhuman', label: '数字人', Icon: UserRound },
] as const;
type Section = typeof sections[number]['id'];
type SectionFlags = Partial<Record<Section, boolean>>;

interface MaterialProps {
  notify: (message: string) => void;
  onBusyChange?: (busy: boolean) => void;
  onDirtyChange?: (dirty: boolean) => void;
}

export default function MarketingMaterials({ notify, onBusyChange, onDirtyChange }: MaterialProps) {
  const id = useId();
  const [section, setSection] = useState<Section>('creative');
  const [visited, setVisited] = useState<SectionFlags>({ creative: true });
  const [busyBySection, setBusyBySection] = useState<SectionFlags>({});
  const [dirtyBySection, setDirtyBySection] = useState<SectionFlags>({});
  const busy = Object.values(busyBySection).some(Boolean);
  const dirty = Object.values(dirtyBySection).some(Boolean);

  // Keep the child callbacks stable while a draft or request changes.
  const [signals] = useState(() => Object.fromEntries(sections.map(({ id }) => [id, {
    onBusyChange: (value: boolean) => setBusyBySection(current => current[id] === value ? current : { ...current, [id]: value }),
    onDirtyChange: (value: boolean) => setDirtyBySection(current => current[id] === value ? current : { ...current, [id]: value }),
  }])) as Record<Section, Pick<MaterialProps, 'onBusyChange' | 'onDirtyChange'>>);

  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => () => { onBusyChange?.(false); onDirtyChange?.(false); }, [onBusyChange, onDirtyChange]);

  function select(next: Section) {
    if (busy) return;
    setVisited(current => current[next] ? current : { ...current, [next]: true });
    setSection(next);
  }

  function handleTabKey(event: KeyboardEvent<HTMLButtonElement>) {
    const { key } = event;
    if (busy || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(key)) return;
    event.preventDefault();
    const current = sections.findIndex(item => item.id === section);
    const last = sections.length - 1;
    const index = key === 'Home' ? 0 : key === 'End' ? last : (current + (key === 'ArrowRight' ? 1 : last)) % sections.length;
    select(sections[index].id);
    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role=tab]')[index]?.focus();
  }

  return <section className="material-workspace" aria-label="AI营销素材">
    <header className="material-heading material-workspace-header">
      <h2>AI营销素材</h2>
      <div className="material-tabs" role="tablist" aria-label="素材功能">
        {sections.map(({ id: value, label, Icon }) => <button key={value} id={`${id}-${value}-tab`} type="button" role="tab"
          aria-selected={section === value} aria-controls={`${id}-${value}-panel`} tabIndex={section === value ? 0 : -1}
          disabled={busy} onClick={() => select(value)} onKeyDown={handleTabKey}><Icon size={15} aria-hidden="true" />{label}</button>)}
      </div>
    </header>
    <div className="material-panel" role="tabpanel" id={`${id}-creative-panel`} aria-labelledby={`${id}-creative-tab`} hidden={section !== 'creative'}>
      <CreativeStudio notify={notify} {...signals.creative} />
    </div>
    <div className="material-panel" role="tabpanel" id={`${id}-moments-panel`} aria-labelledby={`${id}-moments-tab`} hidden={section !== 'moments'}>
      {visited.moments && <MomentsMaterials notify={notify} active={section === 'moments'} {...signals.moments} />}
    </div>
    <div className="material-panel" role="tabpanel" id={`${id}-digitalhuman-panel`} aria-labelledby={`${id}-digitalhuman-tab`} hidden={section !== 'digitalhuman'}>
      {visited.digitalhuman && <DigitalHumanWorkspace notify={notify} active={section === 'digitalhuman'} {...signals.digitalhuman} />}
    </div>
  </section>;
}
