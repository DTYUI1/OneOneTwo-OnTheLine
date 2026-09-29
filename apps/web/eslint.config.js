import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['src/api-client/**', 'dist/**'] },
  js.configs.recommended, ...tseslint.configs.recommended,
  { rules: { '@typescript-eslint/no-explicit-any': 'error' } },
  // Системные alert/confirm/prompt не в стиле АРМ и блокируют страницу — окно ConfirmDialog.
  {
    rules: {
      'no-restricted-globals': ['error', 'alert', 'confirm', 'prompt'],
      'no-restricted-properties': ['error',
        { object: 'window', property: 'alert', message: 'Используйте ConfirmDialog.' },
        { object: 'window', property: 'confirm', message: 'Используйте ConfirmDialog.' },
        { object: 'window', property: 'prompt', message: 'Используйте ConfirmDialog.' },
      ],
    },
  },
);
