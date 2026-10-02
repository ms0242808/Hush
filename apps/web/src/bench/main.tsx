// SPDX-License-Identifier: Apache-2.0
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../i18n';
import { BenchApp } from './BenchApp';
import '../styles/globals.css';

createRoot(document.getElementById('root')!).render(
	<StrictMode>
		<BenchApp />
	</StrictMode>,
);
