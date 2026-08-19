import test from 'node:test';
import {
  buildKnowledgeShadowArtifact,
  validateKnowledgeShadowArtifact,
} from '../builder-shadow-contract.js';

test('knowledge shadow artifact is inert and requires FDE for expansion', () => {
  validateKnowledgeShadowArtifact(buildKnowledgeShadowArtifact('source-session'));
});
