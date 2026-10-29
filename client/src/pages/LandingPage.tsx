import React from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, CheckCircle2, Clock, FileText, Users, ShieldCheck, Smartphone, Globe, LayoutDashboard, Database } from 'lucide-react';
import { ProductManual, ProductOverview } from '../components/ProductGuide';
import { Button, Panel } from '../components/ui';
import '../styles/WorkflowTheme.css';
import './LandingPage.css';

export const LandingPage: React.FC = () => {
  const navigate = useNavigate();
  const [viewMode, setViewMode] = React.useState<'preview' | 'manual'>('preview');

  const handleGuideKey = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 'preview' : event.key === 'End' ? 'manual' :
      event.currentTarget.id === 'guide-tab-preview' ? 'manual' : 'preview';
    setViewMode(next);
    document.getElementById('guide-tab-' + next)?.focus();
  };

  const features = [
    { icon: <Clock />, title: '실시간 근태 관리', description: '출근·퇴근 기록과 개인·관리자 조회로 근태 현황을 확인합니다.' },
    { icon: <CheckCircle2 />, title: '휴가·연차 관리', description: '잔여 연차와 휴가 신청, 권한에 따른 승인·반려를 한곳에서 관리합니다.' },
    { icon: <FileText />, title: '투명한 지출결의', description: '영수증 첨부와 전자결재로 비용 신청 및 승인 내역을 관리합니다.' },
    { icon: <Users />, title: '조직 및 인사 인사이트', description: '회사·본부·팀 구조와 사용자 권한에 따라 직원 정보를 관리합니다.' },
  ];

  return (
    <div className="workflow-theme landing-page">
      <nav className="landing-nav" aria-label="서비스 안내">
        <div className="landing-wrap landing-nav-inner">
          <button type="button" onClick={() => navigate('/')} className="landing-brand" aria-label="HR FLOW 홈"><span className="landing-brand-mark" aria-hidden="true">HF</span><span>HR FLOW</span></button>
          <div className="landing-nav-actions">
            <Button type="button" onClick={() => navigate('/login')} className="wf-btn-quiet">로그인</Button>
            <Button type="button" onClick={() => navigate('/login')} className="wf-btn-primary">무료로 시작하기</Button>
          </div>
        </div>
      </nav>
      <main>
        <section className="landing-wrap landing-hero" aria-labelledby="landing-title">
          <div className="landing-hero-copy">
            <p className="landing-eyebrow"><span aria-hidden="true" />SaaS Cloud HR Platform</p>
            <h1 id="landing-title">기업의 성장을 가속화하는<br /><em>스마트 HR 솔루션</em></h1>
            <p className="landing-hero-description">근태·휴가·경비부터 서류 발급까지. 일상적인 인사·행정 업무를 하나의 플랫폼에서 가장 효율적으로 경험하세요.</p>
            <div className="landing-hero-actions"><Button type="button" onClick={() => navigate('/login')} className="wf-btn-primary">지금 무료로 체험하기<ArrowRight aria-hidden="true" /></Button><span className="landing-trial-note"><ShieldCheck aria-hidden="true" />신용카드 정보 불필요</span></div>
          </div>
          <Panel as="aside" className="landing-workspace" aria-labelledby="landing-workspace-title">
            <div className="landing-workspace-head"><span className="landing-workspace-icon"><LayoutDashboard aria-hidden="true" /></span><div><p>HR FLOW WORKSPACE</p><h2 id="landing-workspace-title">권한에 맞는 업무를 한곳에서</h2></div></div>
            <div className="landing-workspace-rows">
              <div><Clock aria-hidden="true" /><div><h3>개인 업무</h3><p>근태·휴가·지출결의·업무보고</p></div></div>
              <div><FileText aria-hidden="true" /><div><h3>전자결재와 서류</h3><p>신청부터 승인, PDF 보관까지</p></div></div>
              <div><Users aria-hidden="true" /><div><h3>회사 운영</h3><p>조직·인사·급여 통합 관리</p></div></div>
            </div>
            <div className="landing-workflow" aria-label="업무 처리 흐름"><span>신청</span><ArrowRight aria-hidden="true" /><span>결재</span><ArrowRight aria-hidden="true" /><span>보관</span></div>
          </Panel>
        </section>
        <section className="landing-wrap landing-guide" aria-labelledby="landing-guide-title">
          <div className="landing-section-head">
            <div><p className="landing-eyebrow">PRODUCT GUIDE</p><h2 id="landing-guide-title">기능과 사용 방법</h2><p>주요 기능을 살펴보고, 역할에 맞는 업무 절차를 확인하세요.</p></div>
            <div role="tablist" aria-label="제품 기능 안내" className="landing-guide-tabs">
              <button id="guide-tab-preview" role="tab" aria-selected={viewMode === 'preview'} aria-controls="guide-panel-preview" tabIndex={viewMode === 'preview' ? 0 : -1} onKeyDown={handleGuideKey} onClick={() => setViewMode('preview')}><LayoutDashboard aria-hidden="true" />기능 한눈에 보기</button>
              <button id="guide-tab-manual" role="tab" aria-selected={viewMode === 'manual'} aria-controls="guide-panel-manual" tabIndex={viewMode === 'manual' ? 0 : -1} onKeyDown={handleGuideKey} onClick={() => setViewMode('manual')}><FileText aria-hidden="true" />기능요약 설명서</button>
            </div>
          </div>
          <Panel className="landing-guide-panel">
            <div id="guide-panel-preview" role="tabpanel" aria-labelledby="guide-tab-preview" tabIndex={0} hidden={viewMode !== 'preview'} className="landing-guide-content"><ProductOverview /></div>
            <div id="guide-panel-manual" role="tabpanel" aria-labelledby="guide-tab-manual" tabIndex={0} hidden={viewMode !== 'manual'} className="landing-guide-content"><ProductManual /></div>
          </Panel>
        </section>
        <section className="landing-wrap landing-features" aria-labelledby="landing-features-title">
          <div className="landing-section-head"><div><p className="landing-eyebrow">CONNECTED HR</p><h2 id="landing-features-title">하나의 플랫폼, 연결된 HR 업무</h2><p>분산된 업무 툴은 이제 그만. HR Flow가 업무의 기준이 됩니다.</p></div></div>
          <div className="landing-feature-grid">{features.map(feature => <Panel as="article" key={feature.title} className="landing-feature"><span className="landing-feature-icon" aria-hidden="true">{feature.icon}</span><h3>{feature.title}</h3><p>{feature.description}</p></Panel>)}</div>
        </section>
        <section className="landing-benefits" aria-labelledby="landing-benefits-title">
          <div className="landing-wrap landing-benefits-grid">
            <div>
              <p className="landing-eyebrow">YOUR COMPANY, YOUR WORKSPACE</p>
              <h2 id="landing-benefits-title">신뢰할 수 있는<br />클라우드 SaaS 아키텍처</h2>
              <div className="landing-benefit-list">{[
                { icon: <Database />, title: '회사별 접근 권한', desc: '회사별 권한과 서버 접근 검사로 업무정보의 조회·변경 범위를 관리합니다.' },
                { icon: <Smartphone />, title: '모바일 최적화', desc: '화면 크기에 맞춘 웹 화면에서 개인 업무와 관리자 업무를 확인합니다.' },
                { icon: <Globe />, title: '로그인 ID 도메인 관리', desc: '이메일 도메인 확인 후 기존 계정의 로그인 ID 변경을 관리합니다.' },
              ].map(item => <div key={item.title}><span className="landing-benefit-icon" aria-hidden="true">{item.icon}</span><div><h3>{item.title}</h3><p>{item.desc}</p></div></div>)}</div>
            </div>
            <Panel as="aside" className="landing-trial-card"><span className="landing-trial-badge">90일 무료 체험</span><h2>지금 가입하고<br />90일간 무료로 체험하세요</h2><p>회사 설정부터 일상 업무까지 권한에 맞는 기능을 체험할 수 있습니다.</p><Button type="button" onClick={() => navigate('/login')} className="wf-btn-primary">무료 시작하기<ArrowRight aria-hidden="true" /></Button></Panel>
          </div>
        </section>
      </main>
      <footer className="landing-footer"><div className="landing-wrap landing-footer-inner"><div className="landing-brand"><span className="landing-brand-mark" aria-hidden="true">HF</span><span>HR FLOW</span></div><p>© 2026 HR FLOW. All rights reserved.</p><div className="landing-footer-legal"><span>이용약관</span><span>개인정보처리방침</span></div></div></footer>
    </div>
  );
};
