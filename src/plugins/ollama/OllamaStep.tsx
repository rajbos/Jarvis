import { StatusBadge } from '../shared/StatusBadge';
import type { OllamaStatus } from '../types';

interface OllamaStepProps {
  ollama: OllamaStatus | null;
  selectedModel: string | null;
  onToggle: () => void;
  onOpenChat?: () => void;
}

export function OllamaStep({ ollama, selectedModel, onToggle, onOpenChat }: OllamaStepProps) {
  let badgeStatus: 'pending' | 'completed' | 'in-progress' = 'in-progress';
  let badgeLabel = 'Checking...';
  let detail = 'Checking for a local Ollama instance\u2026';

  if (ollama !== null) {
    if (ollama.available) {
      badgeStatus = 'completed';
      badgeLabel = 'Connected';
      detail = selectedModel
        ? `Active model: ${selectedModel} \u2014 click to change`
        : `${ollama.models.length} model${ollama.models.length !== 1 ? 's' : ''} available \u2014 click to select`;
    } else {
      badgeStatus = 'pending';
      badgeLabel = 'Not found';
      detail = 'Ollama not running. Install and start Ollama to enable local AI features.';
    }
  }

  return (
    <div
      class={`step${ollama?.available ? ' ollama-step-clickable' : ''}`}
      id="ollama-step"
      onClick={ollama?.available ? onToggle : undefined}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.4rem' }}>
        <h2 style={{ marginBottom: 0 }}>
          Ollama AI <StatusBadge status={badgeStatus} label={badgeLabel} />
        </h2>
        {ollama?.available && (
          <span style={{ color: '#99a', fontSize: '0.8rem' }}>{'›'}</span>
        )}
      </div>
      <div style={{ fontSize: '0.85rem', color: '#aaa' }}>{detail}</div>
      {ollama?.available && selectedModel && (
        <div style={{ marginTop: '0.6rem' }}>
          <button
            style={{ fontSize: '0.78rem', padding: '0.25rem 0.75rem', background: '#0a3d1f', color: '#51cf66', border: '1px solid #2b8a3e', borderRadius: '5px', cursor: 'pointer' }}
            onClick={(e: MouseEvent) => { e.stopPropagation(); onOpenChat?.(); }}
          >
            {'\uD83D\uDCAC Open Chat'}
          </button>
        </div>
      )}
    </div>
  );
}
