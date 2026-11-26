import { Button, Input, PageTitle, Panel, Select, StatusBadge, Textarea } from '../components/ui';
import React, { useState, useEffect } from 'react';
import { Calendar, History, Send, Loader2, AlertCircle, UploadCloud } from 'lucide-react';
import { collection, query, onSnapshot, addDoc, where } from 'firebase/firestore';
import { db } from '../firebase';
import { uploadCompanyAttachment } from '../services/attachmentService';
import { SecureAttachment } from '../components/SecureAttachment';
import { useAuthStore } from '../store/authStore';
import { calculateTotalLeave } from '../utils/leaveCalculator';
import { format, parseISO, differenceInDays } from 'date-fns';
import './RequestForms.css';

interface LeaveRequest {
  id: string;
  userId: string;
  userName: string;
  type: 'annual' | 'half' | 'sick' | 'other';
  startDate: string;
  endDate: string;
  reason: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  createdAt: string;
  requestDays: number;
  attachmentName?: string;
  attachmentUrl?: string;
  attachmentPath?: string;
}

export const LeaveApplication: React.FC = () => {
  const { userData, user } = useAuthStore();
  const [requests, setRequests] = useState<LeaveRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  // 폼 상태
  const [formData, setFormData] = useState<{
    type: 'annual' | 'half' | 'sick' | 'other';
    startDate: string;
    endDate: string;
    reason: string;
    fileName: string;
    file: File | null;
  }>({
    type: 'annual',
    startDate: format(new Date(), 'yyyy-MM-dd'),
    endDate: format(new Date(), 'yyyy-MM-dd'),
    reason: '',
    fileName: '',
    file: null
  });

  // 연차 계산 (입사일 기반 법정 기본 연차 + 관리자 추가 연차 실시간 집계)
  const totalLeave = calculateTotalLeave(userData?.joinDate, userData?.additionalLeave || 0);
  
  // 승인된 연차/반차 내역만 합산하여 실시간으로 '사용 완료' 계산
  const usedLeave = requests
    .filter(req => req.status === 'APPROVED' && (req.type === 'annual' || req.type === 'half'))
    .reduce((sum, req) => sum + (req.requestDays || 0), 0);
    
  const remainingLeave = totalLeave - usedLeave;

  useEffect(() => {
    if (!user?.uid) return;

    const q = query(
      collection(db, 'leaves'),
      where('companyId', '==', userData?.companyId || ''),
      where('userId', '==', user.uid)
    );

    const unsubscribe = onSnapshot(q, (snap) => {
      const allReqs = snap.docs.map(doc => ({ id: doc.id, ...doc.data() } as LeaveRequest));
      // 생성일 기준 클라이언트 사이드 내림차순 정렬 (인덱스 에러 방지)
      const sorted = [...allReqs].sort((a, b) => 
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );
      setRequests(sorted);
      setLoading(false);
    }, (error) => {
      console.error("Firestore Subscribe Error:", error);
      setLoading(false);
      if (error.code !== 'permission-denied') {
        alert("휴가 정보를 불러오는 데 오류가 발생했습니다. (인덱스/네트워크)");
      }
    });

    return () => unsubscribe();
  }, [user?.uid, userData?.uid, userData?.companyId]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!userData) return;

    // 날짜 차이 계산 (연차 일수)
    const start = parseISO(formData.startDate);
    const end = parseISO(formData.endDate);
    const days = formData.type === 'half' ? 0.5 : differenceInDays(end, start) + 1;

    if (days <= 0) {
      alert("종료일은 시작일보다 빠를 수 없습니다.");
      return;
    }

    if ((formData.type === 'annual' || formData.type === 'half') && days > remainingLeave) {
      alert("잔여 연차가 부족합니다.");
      return;
    }

    try {
      setSubmitting(true);
      
      let attachmentPath = '';
      let attachmentName = '';
      if (formData.file) {
        const uploaded = await uploadCompanyAttachment('leaves', formData.file);
        attachmentPath = uploaded.path; attachmentName = uploaded.name;
      }

      await addDoc(collection(db, 'leaves'), {
        userId: user?.uid || userData?.uid || 'UNKNOWN',
        userName: userData?.name || '가입대기(직원)',
        teamId: userData?.teamId || '',
        divisionId: userData?.divisionId || '',
        type: formData.type || 'annual',
        startDate: formData.startDate || '',
        endDate: formData.endDate || '',
        reason: formData.reason || '',
        attachmentName,
        attachmentPath,
        status: 'PENDING',
        requestDays: days || 0,
        createdAt: new Date().toISOString(),
        companyId: userData?.companyId || ''
      });
      
      alert("휴가 신청이 완료되었습니다.");
      setFormData({
        ...formData,
        reason: '',
        fileName: '',
        file: null
      });
    } catch (err) {
      alert("신청 실패: " + (err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="leave-screen wf-page request-loading" role="status">
        <Loader2 className="request-spinner animate-spin" aria-hidden="true" />
        <span>휴가 정보를 불러오는 중입니다.</span>
      </div>
    );
  }

  return (
    <div className="leave-screen wf-page">
      <div className="request-content">
        <header className="request-page-head">
          <div>
            <div className="request-title-row">
              <Calendar aria-hidden="true" />
              <PageTitle className="wf-title">내 휴가 및 근태 관리</PageTitle>
            </div>
            <p className="request-description">휴가를 신청하고 잔여 연차와 승인 현황을 확인하세요.</p>
          </div>
          
          <div className="leave-summary" aria-label="연차 현황">
            <Panel className="wf-panel request-stat">
              <span>총 발생</span>
              <strong>{totalLeave}<small>일</small></strong>
            </Panel>
            <Panel className="wf-panel request-stat">
              <span>사용 완료</span>
              <strong>{usedLeave}<small>일</small></strong>
            </Panel>
            <Panel className="wf-panel request-stat request-stat-selected">
              <span>잔여 연차</span>
              <strong>{remainingLeave}<small>일</small></strong>
            </Panel>
          </div>
        </header>

        <div className="request-main-grid">
          {/* 신청 폼 */}
          <Panel as="section" className="wf-panel request-form-panel" aria-labelledby="leave-form-title">
              
              <h2 id="leave-form-title" className="wf-section-title request-section-title">
                <Send aria-hidden="true" />
                휴가 신청하기
              </h2>
              
              <form onSubmit={handleSubmit} className="request-form" aria-busy={submitting}>
                <div className="wf-field">
                  <label htmlFor="leave-type">휴가 종류</label>
                  <Select
                    id="leave-type" className="wf-input"
                    value={formData.type}
                    onChange={(e) => setFormData({...formData, type: e.target.value as typeof formData.type})}
                  >
                    <option value="annual">연차 휴가 (1일)</option>
                    <option value="half">반차 휴가 (0.5일)</option>
                    <option value="sick">병가 (공가)</option>
                    <option value="other">기타 (경조사 등)</option>
                  </Select>
                </div>

                <div className="request-field-grid">
                  <div className="wf-field">
                    <label htmlFor="leave-start-date">시작일</label>
                    <Input
                      id="leave-start-date" type="date" className="wf-input"
                      value={formData.startDate}
                      onChange={(e) => setFormData({...formData, startDate: e.target.value})}
                    />
                  </div>
                  <div className="wf-field">
                    <label htmlFor="leave-end-date">종료일</label>
                    <Input
                      id="leave-end-date" type="date"
                      disabled={formData.type === 'half'}
                      className="wf-input"
                      value={formData.type === 'half' ? formData.startDate : formData.endDate}
                      onChange={(e) => setFormData({...formData, endDate: e.target.value})}
                    />
                  </div>
                </div>

                <div className="wf-field">
                  <label htmlFor="leave-reason">사유</label>
                  <Textarea
                    id="leave-reason"
                    rows={3}
                    placeholder="사유를 입력해 주세요"
                    className="wf-input"
                    value={formData.reason}
                    onChange={(e) => setFormData({...formData, reason: e.target.value})}
                  />
                </div>

                <div className="wf-field">
                   <span id="leave-file-label">증빙 파일 <small>(병가·경조사 등)</small></span>
                   <label className="request-upload" htmlFor="leave-file">
                      <div className="request-upload-copy">
                         <UploadCloud aria-hidden="true" />
                         <span>
                           {formData.fileName ? formData.fileName : '증빙 서류 이미지 또는 PDF 업로드'}
                         </span>
                      </div>
                      <input 
                        id="leave-file" type="file" className="request-file-input" accept="image/*,.pdf" aria-labelledby="leave-file-label"
                        onChange={(e) => {
                          if (e.target.files && e.target.files[0]) {
                            const file = e.target.files[0];
                            setFormData({...formData, fileName: file.name, file: file});
                          }
                        }} 
                      />
                   </label>
                </div>

                <Button
                  type="submit"
                  disabled={submitting}
                  className="wf-btn wf-btn-primary request-submit"
                >
                  {submitting ? <><Loader2 className="animate-spin" aria-hidden="true" /><span>제출 중...</span></> : (
                    <>
                      <span>신청서 제출</span>
                      <Send aria-hidden="true" />
                    </>
                  )}
                </Button>
              </form>
          </Panel>

          {/* 신청 내역 */}
          <div className="request-history-column">
            <Panel as="section" className="wf-panel request-history-panel" aria-labelledby="leave-history-title">
              <div className="wf-panel-head request-history-head">
                <h2 id="leave-history-title" className="wf-section-title request-section-title">
                  <History aria-hidden="true" />
                  최근 신청 내역
                </h2>
                <span className="request-count">총 {requests.length}건</span>
              </div>
              
              <div className="request-table-wrap">
                <table className="request-table">
                  <caption className="request-sr-only">최근 휴가 신청 내역</caption>
                  <thead>
                    <tr>
                      <th scope="col">종류</th>
                      <th scope="col">기간 / 사유</th>
                      <th scope="col">사용일</th>
                      <th scope="col">상태</th>
                    </tr>
                  </thead>
                  <tbody>
                    {requests.map((req) => (
                      <tr key={req.id}>
                        <td data-label="종류">
                          <span className={`request-type ${
                            req.type === 'annual' ? 'request-type-annual' :
                            req.type === 'half' ? 'request-type-half' :
                            'request-type-other'
                          }`}>
                            {req.type === 'annual' ? '연차' :
                             req.type === 'half' ? '반차' :
                             req.type === 'sick' ? '병가' : '기타'}
                          </span>
                        </td>
                        <td data-label="기간 / 사유" className="request-detail-cell">
                          <div className="request-record-title">
                            {req.startDate} {req.type !== 'half' && `~ ${req.endDate}`}
                          </div>
                          <div className="request-record-description">{req.reason}</div>
                          {(req.attachmentPath || req.attachmentUrl) && <div className="request-attachment"><SecureAttachment category="leaves" documentId={req.id} name={req.attachmentName} /></div>}
                        </td>
                        <td data-label="사용일" className="request-nowrap">
                          <span>{req.requestDays}일</span>
                        </td>
                        <td data-label="상태">
                          <StatusBadge className={`wf-status ${
                            req.status === 'APPROVED' ? 'wf-status-success' :
                            req.status === 'REJECTED' ? 'wf-status-error' :
                            'wf-status-warning'
                          }`}>
                            {req.status === 'APPROVED' ? '승인완료' : 
                             req.status === 'REJECTED' ? '반려됨' : '심사중'}
                          </StatusBadge>
                        </td>
                      </tr>
                    ))}
                    {requests.length === 0 && (
                      <tr>
                        <td colSpan={4} className="request-empty-cell">
                          <div className="request-empty">
                             <Calendar aria-hidden="true" />
                             <p>최근 신청 내역이 없습니다.</p>
                          </div>
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </Panel>

            {/* 안내 배너 */}
            <Panel as="aside" className="wf-panel request-notice">
              <AlertCircle aria-hidden="true" />
                <div>
                  <h3>연차 산정 기준 안내</h3>
                  <p>당사 근태 규정은 대한민국 근로기준법을 준수합니다. 1년 미만 근속자는 매월 개근 시 1일이 발생하며, 1년 이상 근속 시 연 15일의 연차가 발생합니다. (매 2년 근속 시 1일 가산, 최대 25일 한도)</p>
                </div>
            </Panel>
          </div>
        </div>
      </div>
    </div>
  );
};
