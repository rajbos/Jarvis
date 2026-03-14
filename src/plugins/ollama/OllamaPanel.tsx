import type { OllamaStatus } from '../types';

interface OllamaPanelProps {
  ollama: OllamaStatus;
  selectedModel: string | null;
  onSelectModel: (modelName: string) => void;
  onClose: () => void;
}

export function OllamaPanel({ ollama, selectedModel, onSelectModel, onClose }: OllamaPanelProps) {
  return (
    <div class="org-panel ollama-panel">
      <div class="org-panel-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span>Ollama</span>
        <button class="repo-panel-close" title="Close" onClick={onClose}>&times;</button>
      </div>
      <div style={{ fontSize: '0.82rem', color: '#99aabb', marginBottom: '0.75rem' }}>
        <code style={{ background: '#0f3460', padding: '0.1rem 0.4rem', borderRadius: '3px' }}>
          {ollama.baseUrl}
        </code>
      </div>
      {ollama.models.length === 0 ? (
        <div style={{ color: '#99a', fontSize: '0.85rem' }}>No models found</div>
      ) : (
        <ul class="ollama-model-list">
          {ollama.models.map((m) => {
            const isSelected = selectedModel === m.name;
            return (
              <li key={m.name} class={`ollama-model-item${isSelected ? ' ollama-model-selected' : ''}`}>
                <span class="ollama-model-name">{m.name}</span>
                {m.details?.parameter_size && (
                  <span class="ollama-model-meta">{m.details.parameter_size}</span>
                )}
                {m.details?.quantization_level && (
                  <span class="ollama-model-meta">{m.details.quantization_level}</span>
                )}
                <span class="ollama-model-meta">{(m.size / 1e9).toFixed(1)} GB</span>
                <button
                  class={`ollama-model-select-btn${isSelected ? ' ollama-model-select-btn-active' : ''}`}
                  title={isSelected ? 'Currently selected' : 'Use this model'}
                  onClick={() => onSelectModel(m.name)}
                >
                  {isSelected ? '\u2713 Selected' : 'Use'}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
