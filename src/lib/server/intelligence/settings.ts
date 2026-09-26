// The settings an intelligence read runs with. Phase 1 has no saved settings: every organisation
// gets the built-in defaults, and changing a threshold is a code change. Phase 2 reads the
// organisation's saved revision here and falls back to these defaults (plan §3).
import { DEFAULT_CONFIG, type IntelligenceConfig } from '$lib/intelligence/config';

export interface EffectiveConfig {
	config: IntelligenceConfig;
	source: 'defaults';
	revision: number;
}

/**
 * DEFAULT_CONFIG starts disabled so a future saved configuration, and the background evaluation
 * that reads it, begin switched off. A dossier opened by someone holding intelligence read is an
 * explicit, on-demand request, so it evaluates the defaults with the module on and in shadow
 * mode: it computes and shows, and creates no review work (there is none to create in phase 1).
 */
export function effectiveConfig(): EffectiveConfig {
	return {
		config: { ...structuredClone(DEFAULT_CONFIG), enabled: true, mode: 'shadow' },
		source: 'defaults',
		revision: 0
	};
}
