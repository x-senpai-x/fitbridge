import { expect, it } from 'vitest';
import { exerciseName } from '../src/exercise-types';

it.each([
  ['56', 'running'],
  ['79', 'walking'],
  ['0', 'other workout'],
  ['36', 'high intensity interval training'],
  ['999', 'exercise type 999'],
  ['running', 'running'],
])('names Health Connect exercise type %s as %s', (type, name) => {
  expect(exerciseName(type)).toBe(name);
});
