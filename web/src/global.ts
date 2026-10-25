// Script-tag build: <script src="baziness.global.js"></script> → window.Baziness
import * as Baziness from './index.js';

(globalThis as unknown as { Baziness: typeof Baziness }).Baziness = Baziness;
