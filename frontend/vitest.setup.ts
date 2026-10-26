import "@testing-library/jest-dom/vitest";

// DOM updates under concurrent full-suite load may take more than 1s (#441).
import { configure } from '@testing-library/react';
configure({ asyncUtilTimeout: 5000 });
