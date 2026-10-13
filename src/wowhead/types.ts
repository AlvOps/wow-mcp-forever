/**
 * Wowhead entity types. `id` is Wowhead's numeric type id (used in search
 * results), `path` is the URL segment (wowhead.com/forever/<path>=<id>) and
 * `tooltip` is the segment used by the tooltip service.
 */
export interface EntityType {
  id: number;
  name: string;
  path: string;
  tooltip: string;
}

export const ENTITY_TYPES: EntityType[] = [
  { id: 1, name: 'npc', path: 'npc', tooltip: 'npc' },
  { id: 2, name: 'object', path: 'object', tooltip: 'object' },
  { id: 3, name: 'item', path: 'item', tooltip: 'item' },
  { id: 4, name: 'itemset', path: 'item-set', tooltip: 'item-set' },
  { id: 5, name: 'quest', path: 'quest', tooltip: 'quest' },
  { id: 6, name: 'spell', path: 'spell', tooltip: 'spell' },
  { id: 7, name: 'zone', path: 'zone', tooltip: 'zone' },
  { id: 8, name: 'faction', path: 'faction', tooltip: 'faction' },
  { id: 10, name: 'achievement', path: 'achievement', tooltip: 'achievement' },
  { id: 11, name: 'title', path: 'title', tooltip: 'title' },
  { id: 12, name: 'event', path: 'event', tooltip: 'event' },
  { id: 13, name: 'class', path: 'class', tooltip: 'class' },
  { id: 14, name: 'race', path: 'race', tooltip: 'race' },
  { id: 15, name: 'skill', path: 'skill', tooltip: 'skill' },
  { id: 17, name: 'currency', path: 'currency', tooltip: 'currency' },
  // Guides are real Forever content — the documented walkthroughs of the
  // added dungeons live here (e.g. /forever/guide=34887, The Hall of Thanes),
  // and Wowhead's search returns them next to zones. Their canonical URL is a
  // slug (/forever/guide/<slug>), not `<path>=<id>`; see client.looksLikeEntity.
  { id: 100, name: 'guide', path: 'guide', tooltip: 'guide' },
];

export const ENTITY_TYPE_NAMES = ENTITY_TYPES.map((t) => t.name) as [string, ...string[]];

export function typeByName(name: string): EntityType | undefined {
  const n = name.toLowerCase().replace(/[\s_-]/g, '');
  return ENTITY_TYPES.find((t) => t.name === n || t.path.replace('-', '') === n);
}

export function typeById(id: number): EntityType | undefined {
  return ENTITY_TYPES.find((t) => t.id === id);
}

export const QUALITY_NAMES = [
  'Poor',
  'Common',
  'Uncommon',
  'Rare',
  'Epic',
  'Legendary',
  'Artifact',
  'Heirloom',
];
