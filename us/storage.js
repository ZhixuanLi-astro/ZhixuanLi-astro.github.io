import { newState, validateState, appendRecord, reverseRecord } from './model.js?v=3';

export const STORAGE_KEY = 'our-little-universe:v1';

export function createLocalStore(initialScore) {
  // Fail visibly on denied storage or corrupt data. Never silently replace a diary.
  const read = () => {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? validateState(JSON.parse(raw)) : newState(initialScore);
  };
  const write = state => localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  const mutate = async action => {
    const perform = () => { const next = action(read()); write(next); return next; };
    return navigator.locks ? navigator.locks.request(STORAGE_KEY, perform) : perform();
  };
  return {
    mode: 'local',
    async load() { const state = read(); if (!localStorage.getItem(STORAGE_KEY)) write(state); return state; },
    add: record => mutate(state => appendRecord(state, record)),
    undo: id => mutate(state => reverseRecord(state, id)),
    import: value => mutate(() => validateState(value)),
    subscribe(callback) {
      const listener = e => { if (e.key === STORAGE_KEY) callback(); };
      window.addEventListener('storage', listener);
      return () => window.removeEventListener('storage', listener);
    },
  };
}
