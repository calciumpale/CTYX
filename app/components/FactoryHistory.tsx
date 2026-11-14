'use client';

import { useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import StudioAssets from './StudioAssets';
import { downloadStudioCopy, studioRequest } from '../lib/creative-studio-client';
import { buildStudioCodeZip, downloadStudioBlob } from '../lib/creative-studio-export';
import type { StudioRecord, StudioSummary } from '../lib/creative-studio-types';
import type { PublicMaterialTask } from '../lib/marketing-material-types';
import './creative-studio.css';

export default function FactoryHistory({ onBusyChange }: { onBusyChange: (busy: boolean) => void }) {
  const [tasks, setTasks] = useState<PublicMaterialTask[]>([]);
  const [projects, setProjects] = useState<StudioSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [mediaError, setMediaError] = useState('');
  const [projectError, setProjectError] = useState('');
  useEffect(() => { onBusyChange(busy); return () => onBusyChange(false); }, [busy, onBusyChange]);

  async function loadMedia() {
    setLoading(true);
    setMediaError('');
    try {
      setTasks((await studioRequest<{ tasks: PublicMaterialTask[] }>('', undefined, '/api/marketing-materials')).tasks);
    } catch (reason) {
      setMediaError(reason instanceof Error ? reason.message : '无法读取历史素材。');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadMedia();
    void studioRequest<{ projects: StudioSummary[] }>().then(response => {
      setProjects(response.projects);
    }).catch(reason => setProjectError(reason instanceof Error ? reason.message : '无法读取历史创作。'));
  }, []);

  async function refreshTask(task: PublicMaterialTask) {
    setBusy(true);
    setMediaError('');
    try {
      const response = await studioRequest<{ task: PublicMaterialTask }>('', { action: 'refresh', taskId: task.id, version: task.version }, '/api/marketing-materials');
      setTasks(items => items.map(item => item.id === task.id ? response.task : item));
    } catch (reason) {
      setMediaError(reason instanceof Error ? reason.message : '无法查询素材状态。');
    } finally {
      setBusy(false);
    }
  }

  async function exportProject(project: StudioSummary) {
    setBusy(true);
    setProjectError('');
    try {
      const data = await studioRequest<{ project: StudioRecord }>(`?id=${encodeURIComponent(project.id)}`);
      const document = data.project.document;
      if (document.boards.length) {
        downloadStudioBlob(new Blob([await buildStudioCodeZip(document, 'html')], { type: 'application/zip' }), `${document.title.replace(/[\\/:*?"<>|]/g, '-') || '历史创作'}.zip`);
      }
      if (document.copy.title || document.copy.caption || document.copy.script || document.copy.coverPrompt || document.copy.shots.length) {
        downloadStudioCopy(document);
      } else if (!document.boards.length) {
        setProjectError('此项目还没有可导出的稿件或画板。');
      }
    } catch (reason) {
      setProjectError(reason instanceof Error ? reason.message : '无法导出历史创作。');
    } finally {
      setBusy(false);
    }
  }

  return <div className="cf-copy">
      <StudioAssets tasks={tasks} loading={loading} busy={busy} error={mediaError} onReload={() => void loadMedia()} onRefresh={task => void refreshTask(task)} />
      {projectError && <p className="cf-feedback" role="alert">{projectError}</p>}
      {projects.length > 0 && <section aria-label="历史创作">
        <h3>历史创作</h3>
        <ul className="cf-queue-list">{projects.map(project => <li className="cf-queue-item" key={project.id}>
          <span>{project.title}</span><button className="button secondary" type="button" disabled={busy} onClick={() => void exportProject(project)}><Download size={15} />导出</button>
        </li>)}</ul>
      </section>}
  </div>;
}
