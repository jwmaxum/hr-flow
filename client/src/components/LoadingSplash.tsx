import React from 'react';
import { Loader2 } from 'lucide-react';
import '../styles/WorkflowTheme.css';
import '../styles/AuthStates.css';

export const LoadingSplash: React.FC = () => {
  return (
    <div className="workflow-theme auth-state-screen auth-loading-screen" role="status" aria-live="polite">
      <div className="auth-loading-content">
        <span className="auth-state-brand" aria-hidden="true">HF</span>
        <h1>HR Flow</h1>
        <p className="auth-loading-status"><Loader2 aria-hidden="true" />애플리케이션을 불러오는 중...</p>
        <p>인증 정보를 확인하고 있습니다</p>
      </div>
      <p className="auth-loading-copyright">© 2026 HR Flow System</p>
    </div>
  );
};
