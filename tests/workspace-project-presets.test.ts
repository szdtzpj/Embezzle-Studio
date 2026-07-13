import { describe, expect, it } from 'vitest';

import { workspaceProjectPresets } from '../src/data/workspaceProjectPresets';
import type { WorkspaceProject } from '../src/domain/types';
import {
  MAX_WORKSPACE_PROJECT_NAME_LENGTH,
  MAX_WORKSPACE_PROJECT_SYSTEM_PROMPT_LENGTH,
  createWorkspaceProject,
} from '../src/services/workspaceProjects';
import { unicodeCharacterLength } from '../src/services/textBounds';

describe('local workspace project presets', () => {
  it('provides four complete presets with unique IDs and bounded project fields', () => {
    expect(workspaceProjectPresets.map((preset) => preset.title)).toEqual([
      '研究分析',
      '写作编辑',
      '软件开发',
      '学习整理',
    ]);

    const ids = new Set<string>();
    for (const preset of workspaceProjectPresets) {
      expect(preset.id.trim()).not.toBe('');
      expect(preset.title.trim()).not.toBe('');
      expect(preset.description.trim()).not.toBe('');
      expect(preset.suggestedName.trim()).not.toBe('');
      expect(preset.systemPrompt.trim()).not.toBe('');
      expect(ids.has(preset.id)).toBe(false);
      ids.add(preset.id);

      expect(unicodeCharacterLength(preset.suggestedName)).toBeLessThanOrEqual(
        MAX_WORKSPACE_PROJECT_NAME_LENGTH
      );
      expect(unicodeCharacterLength(preset.systemPrompt)).toBeLessThanOrEqual(
        MAX_WORKSPACE_PROJECT_SYSTEM_PROMPT_LENGTH
      );
    }
    expect(ids.size).toBe(4);
  });

  it('contains instructions only, without provider, model, credential, or remote-tool configuration', () => {
    for (const preset of workspaceProjectPresets) {
      expect(Object.keys(preset).sort()).toEqual([
        'description',
        'id',
        'suggestedName',
        'systemPrompt',
        'title',
      ]);
      expect(preset).not.toHaveProperty('providerId');
      expect(preset).not.toHaveProperty('modelId');
      expect(preset).not.toHaveProperty('defaultTarget');
    }

    expect(JSON.stringify(workspaceProjectPresets)).not.toMatch(
      /https?:|api.?key|providerId|modelId|defaultTarget|\bmcp\b|\bsearch\b|联网|网络请求/i
    );
  });

  it('creates ordinary local projects without mutating the preset collection', () => {
    const originalPresets = workspaceProjectPresets.map((preset) => ({ ...preset }));
    let projects: WorkspaceProject[] = [];

    workspaceProjectPresets.forEach((preset, index) => {
      projects = createWorkspaceProject(
        projects,
        {
          name: preset.suggestedName,
          systemPrompt: preset.systemPrompt,
        },
        { id: `preset-project-${index + 1}`, now: index + 1 }
      );
    });

    expect(projects).toHaveLength(4);
    for (const preset of workspaceProjectPresets) {
      expect(projects).toContainEqual(
        expect.objectContaining({
          name: preset.suggestedName,
          systemPrompt: preset.systemPrompt,
        })
      );
    }
    expect(projects.every((project) => project.defaultTarget === undefined)).toBe(true);
    expect(workspaceProjectPresets).toEqual(originalPresets);
  });
});
