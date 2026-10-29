import { Button, Input, PageTitle, Panel, Select, StatusBadge, Textarea } from '../components/ui';
import React, { useState, useEffect } from 'react';
import { 
  UploadCloud, CheckCircle, FileText, History, AlertCircle, Send, Loader2, DollarSign, X, Trash2, Edit, Clock, Calendar 
} from 'lucide-react';
import { addDoc, collection, query, where, onSnapshot, doc, updateDoc, deleteDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { uploadCompanyAttachment } from '../services/attachmentService';
import { SecureAttachment } from '../components/SecureAttachment';
import { useAuthStore } from '../store/authStore';
import { format } from 'date-fns';
import './RequestForms.css';

interface ExpenseRequest {
  id: string;
  userId: string;
  userName: string;
  title: string;
  amount: number;
  date: string;
  category: string;
  description: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  createdAt: string;
  attachmentName?: string;
  attachmentUrl?: string;
  attachmentPath?: string;
}

export const ExpenseForm: React.FC = () => {
  const { userData, user, loading: authLoading } = useAuthStore();
  const [title, setTitle] = useState('');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState('');
  const [category, setCategory] = useState('식비/회식대');
  const [description, setDescription] = useState('');
  const [fileName, setFileName] = useState('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [requests, setRequests] = useState<ExpenseRequest[]>([]);
  const [loading, setLoading] = useState(true);

  // 상세 보기 및 수정 관련 상태
  const [selectedRequest, setSelectedRequest] = useState<ExpenseRequest | null>(null);
  const [editingRequest, setEditingRequest] = useState<ExpenseRequest | null>(null); // 현재 수정 중인 원본 데이터
  const [isEditing, setIsEditing] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [filterMonth, setFilterMonth] = useState(format(new Date(), 'yyyy-MM'));

  useEffect(() => {
    if (authLoading || !user?.uid) return;

    const q = query(
      collection(db, 'expenses'),
      where('companyId', '==', userData?.companyId || ''),
      where('userId', '==', user.uid)
    );
    
    const unsubscribe = onSnapshot(q, (snap) => {
      const allReqs = snap.docs.map(doc => ({ id: doc.id, ...doc.data() } as ExpenseRequest));
      // 클라이언트 사이드에서 생성일 기준 내림차순 정렬 (인덱스 에러 방지)
      const sorted = [...allReqs].sort((a, b) => 
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );
      setRequests(sorted);
      setLoading(false);
    }, (error) => {
      console.error("Firestore Subscribe Error:", error);
      setLoading(false);
      // 권한이나 색인 문제가 있을 경우 콘솔에 기록 (alert 제거)
      if (error.code !== 'permission-denied') {
        console.error("Firestore Permission/Index Error:", error);
      }
    });

    return () => unsubscribe();
  }, [user?.uid, userData?.companyId, authLoading]);

  // 필터링된 내역 계산
  const filteredRequests = filterMonth === 'all' 
    ? requests 
    : requests.filter(req => req.date.substring(0, 7) === filterMonth);

  // 최근 12개월 목록 생성 (필터용)
  const monthStart = new Date();
  const monthOptions = Array.from({ length: 13 }, (_, i) => {
    if (i === 12) return { value: 'all', label: '전체 보기' };
    const d = new Date(monthStart.getFullYear(), monthStart.getMonth() - i, 1);
    return { 
      value: format(d, 'yyyy-MM'), 
      label: format(d, 'yyyy년 MM월') 
    };
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);

    try {
      // 0. 초기화: undefined 방지를 위해 기본값 보장
      let finalPath = editingRequest?.attachmentPath || '';
      let finalName = fileName || editingRequest?.attachmentName || '';
      
      // 1. 파일 업로드 로직 (새 파일이 선택된 경우에만)
      if (selectedFile) {
        const uploaded = await uploadCompanyAttachment('expenses', selectedFile);
        finalPath = uploaded.path; finalName = uploaded.name;
      }

      // 2. 페이로드 구성 (모든 필드에 대해 undefined 방지 처리)
      const payload = {
        userId: user?.uid || userData?.uid || 'UNKNOWN',
        userName: userData?.name || '가입대기(직원)',
        teamId: userData?.teamId || '',
        divisionId: userData?.divisionId || '',
        title: title || '제목 없음',
        amount: Number(amount) || 0,
        date: date || new Date().toISOString().split('T')[0],
        category: category || '기타',
        description: description || '',
        attachmentName: finalName || '',
        attachmentPath: finalPath,
        ...(selectedFile ? { attachmentUrl: '' } : {}),
        status: isEditing ? (editingRequest?.status || 'PENDING') : 'PENDING',
        updatedAt: new Date().toISOString()
      };

      console.log("💾 Saving document...", isEditing ? "UPDATE" : "CREATE");

      if (isEditing && editingId) {
        // 기존 문서 업데이트
        await updateDoc(doc(db, 'expenses', editingId), payload);
        alert('지출결의서 수정이 완료되었습니다.');
        setIsEditing(false);
        setEditingId(null);
        setEditingRequest(null);
        setSelectedRequest(null);
      } else {
        // 신규 등록
        if (!userData?.companyId) throw new Error("회사 정보(companyId)가 없습니다. 다시 로그인해 주세요.");
        
        await addDoc(collection(db, 'expenses'), {
          ...payload,
          createdAt: new Date().toISOString(),
          companyId: userData.companyId
        });
        setIsSuccess(true);
      }
      
      // 폼 초기화 (수정/신규 공통)
      setTitle('');
      setAmount('');
      setDate('');
      setDescription('');
      setFileName('');
      setSelectedFile(null);
      
    } catch (error) {
      console.error('Submit/Update Error Detailed:', error);
      const errorMsg = (error as Error).message;
      alert('처리 중 오류가 발생했습니다.\n\n원인: ' + errorMsg);
    } finally {
      setIsSubmitting(false); // 무한 로딩 방어: 어떤 경우에도 로딩 해제
    }
  };

  const handleEdit = (req: ExpenseRequest) => {
    if (req.status !== 'PENDING') {
      alert('승인 대기 중인 안건만 수정할 수 있습니다.');
      return;
    }
    
    // 수정을 위해 폼 데이터 채우기
    setIsEditing(true);
    setEditingId(req.id);
    setEditingRequest(req); // 원본 데이터 보관
    
    setTitle(req.title);
    setAmount(req.amount.toString());
    setDate(req.date);
    setCategory(req.category);
    setDescription(req.description);
    setFileName(req.attachmentName || '');
    setSelectedFile(null); // 기존 파일은 URL로 유지
    
    // 모달 닫기 (모달을 통해 진입했을 경우)
    setSelectedRequest(null);
    
    // 페이지 상단 폼으로 스크롤 이동
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleCancelEdit = () => {
    setIsEditing(false);
    setEditingId(null);
    setEditingRequest(null);
    setTitle('');
    setAmount('');
    setDate('');
    setDescription('');
    setFileName('');
    setSelectedFile(null);
    setSelectedRequest(null);
  };

  const handleDelete = async (id: string, status: string) => {
    if (status !== 'PENDING') {
      alert('승인 대기 중인 안건만 삭제할 수 있습니다.');
      return;
    }
    
    if (!window.confirm('이 신청 건을 삭제하시겠습니까?')) return;
    
    try {
      await deleteDoc(doc(db, 'expenses', id));
      alert('삭제되었습니다.');
      if (selectedRequest?.id === id) setSelectedRequest(null);
    } catch (err) {
      alert('삭제 실패: ' + (err as Error).message);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      const file = e.target.files[0];
      setFileName(file.name);
      setSelectedFile(file);
    }
  };

  if (authLoading) {
    return (
      <div className="expense-screen wf-page request-loading" role="status">
        <div className="request-loading-copy">
          <Loader2 className="request-spinner animate-spin" aria-hidden="true" />
          <p>보안 세션 연결 중...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="expense-screen wf-page">
      <div className="request-content">
        
        {/* Header */}
        <header className="request-page-head">
          <div>
            <div className="request-title-row">
              <FileText aria-hidden="true" />
              <PageTitle className="wf-title">지출결의 신청</PageTitle>
            </div>
            <p className="request-description">지출 내역과 영수증을 제출하고 처리 상태를 확인하세요.</p>
          </div>
          
          <Panel className="wf-panel request-stat request-stat-selected expense-pending">
            <div>
              <span>승인 대기</span>
              <strong>
                {requests.filter(r => r.status === 'PENDING').length}<small>건</small>
              </strong>
            </div>
          </Panel>
        </header>

        <div className="request-main-grid">
          
          {/* 신청 폼 */}
          <Panel as="section" className="wf-panel request-form-panel" aria-label="지출결의 작성">
              
              {isSuccess ? (
                <div className="expense-success" role="status">
                  <CheckCircle aria-hidden="true" />
                  <h2 className="wf-section-title">신청 완료!</h2>
                  <p>재무 담당자가 확인 후 승인 처리됩니다.</p>
                  <Button
                    onClick={() => setIsSuccess(false)}
                    className="wf-btn wf-btn-primary"
                  >
                    추가 신청하기
                  </Button>
                </div>
              ) : (
                <form onSubmit={handleSubmit} className="request-form" aria-busy={isSubmitting}>
                  <div className="wf-panel-head expense-form-head">
                    <h2 className="wf-section-title request-section-title">
                       <Send aria-hidden="true" />
                       {isEditing ? '지출 결의서 수정' : '새 결의서 작성'}
                    </h2>
                    {isEditing && (
                      <Button
                         type="button"
                         onClick={handleCancelEdit}
                         className="wf-btn wf-btn-quiet expense-cancel-edit"
                      >
                         <X aria-hidden="true" /> 수정 취소
                      </Button>
                    )}
                  </div>

                  <div className="request-field-grid">
                    <div className="wf-field request-field-full">
                      <label htmlFor="expense-title">지출 항목명 <span aria-hidden="true">*</span></label>
                      <Input
                        id="expense-title" type="text" required
                        value={title} onChange={(e) => setTitle(e.target.value)}
                        placeholder="예: 3월 본부 회식비"
                        className="wf-input"
                      />
                    </div>

                    <div className="wf-field">
                      <label htmlFor="expense-category">분류</label>
                      <Select
                        id="expense-category"
                        value={category} onChange={(e) => setCategory(e.target.value)}
                        className="wf-input"
                      >
                        <option value="식비/회식대">식비/회식대</option>
                        <option value="교통/출장비">교통/출장비</option>
                        <option value="비품/소모품">비품/소모품</option>
                        <option value="접대/미팅비">접대/미팅비</option>
                        <option value="기타">기타 비용</option>
                      </Select>
                    </div>

                    <div className="wf-field">
                      <label htmlFor="expense-amount">금액 (원) <span aria-hidden="true">*</span></label>
                      <div className="expense-amount-field">
                        <Input
                          id="expense-amount" type="number" required min="1"
                          value={amount} onChange={(e) => setAmount(e.target.value)}
                          placeholder="0"
                          className="wf-input"
                        />
                        <DollarSign aria-hidden="true" />
                      </div>
                    </div>

                    <div className="wf-field request-field-full">
                       <label htmlFor="expense-date">결제일 <span aria-hidden="true">*</span></label>
                       <Input
                         id="expense-date" type="date" required
                         value={date} onChange={(e) => setDate(e.target.value)}
                         className="wf-input"
                       />
                    </div>
                  </div>

                  <div className="wf-field">
                    <label htmlFor="expense-description">상세 내역 <span aria-hidden="true">*</span></label>
                    <Textarea
                      id="expense-description" required rows={3}
                      value={description} onChange={(e) => setDescription(e.target.value)}
                      placeholder="참여자 및 목적을 간단히 적어주세요."
                      className="wf-input"
                    />
                  </div>

                  <div className="wf-field">
                     <span id="expense-file-label">증빙 자료 <small>이미지 또는 PDF</small></span>
                     <label className="request-upload" htmlFor="expense-file">
                        <div className="request-upload-copy">
                           <UploadCloud aria-hidden="true" />
                           <span>
                             {fileName ? fileName : '영수증 이미지 또는 PDF 파일 업로드'}
                           </span>
                        </div>
                        <input id="expense-file" type="file" className="request-file-input" accept="image/*,.pdf" onChange={handleFileChange} aria-labelledby="expense-file-label" />
                     </label>
                  </div>

                  <Button
                    type="submit" 
                    disabled={isSubmitting}
                    className="wf-btn wf-btn-primary request-submit"
                  >
                    {isSubmitting ? <><Loader2 className="animate-spin" aria-hidden="true" /><span>제출 중...</span></> : (
                      <>
                        <span>{isEditing ? '결의서 수정 완료' : '지출결의 제출'}</span>
                        <Send aria-hidden="true" />
                      </>
                    )}
                  </Button>
                </form>
              )}
          </Panel>

          {/* 신청 내역 */}
          <Panel as="section" className="wf-panel request-history-panel" aria-labelledby="expense-history-title">
               <div className="wf-panel-head request-history-head">
                  <h2 id="expense-history-title" className="wf-section-title request-section-title">
                    <History aria-hidden="true" />
                    나의 신청 내역
                  </h2>
                  
                  {/* 월별 필터 UI */}
                  <div className="expense-month-filter">
                    <label htmlFor="expense-filter-month" className="request-sr-only">신청 내역 조회 월</label>
                    <Select
                      id="expense-filter-month"
                      value={filterMonth}
                      onChange={(e) => setFilterMonth(e.target.value)}
                      className="wf-input"
                    >
                      {monthOptions.map(opt => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </Select>
                    <Calendar aria-hidden="true" />
                  </div>
               </div>

               <div className="request-table-wrap">
                 <table className="request-table">
                    <caption className="request-sr-only">나의 지출결의 신청 내역. 항목명을 선택하면 상세 내용을 볼 수 있습니다.</caption>
                    <thead>
                       <tr>
                          <th scope="col">분류 / 날짜</th>
                          <th scope="col">항목명</th>
                          <th scope="col" className="expense-amount-cell">금액</th>
                          <th scope="col">상태</th>
                       </tr>
                    </thead>
                    <tbody>
                       {filteredRequests.map((req) => (
                          <tr 
                            key={req.id} 
                            onClick={() => setSelectedRequest(req)}
                            className="expense-record"
                          >
                             <td data-label="분류 / 날짜">
                                <div className="expense-record-category">{req.category}</div>
                                <div className="request-record-description">{req.date}</div>
                             </td>
                             <td data-label="항목명" className="request-detail-cell">
                                <button type="button" className="expense-record-button" aria-haspopup="dialog" aria-label={`${req.title} 상세 보기`}>{req.title}</button>
                             </td>
                             <td data-label="금액" className="expense-amount-cell">
                                <span>₩ {req.amount.toLocaleString()}</span>
                             </td>
                             <td data-label="상태">
                                   <StatusBadge className={`wf-status ${
                                      req.status === 'APPROVED' ? 'wf-status-success' :
                                      req.status === 'REJECTED' ? 'wf-status-error' :
                                      'wf-status-warning'
                                   }`}>
                                      {req.status === 'APPROVED' ? '승인' : 
                                       req.status === 'REJECTED' ? '반려' : '대기'}
                                   </StatusBadge>
                             </td>
                          </tr>
                       ))}
                       {filteredRequests.length === 0 && !loading && (
                          <tr>
                             <td colSpan={4} className="request-empty-cell">
                                <div className="request-empty">
                                   <History aria-hidden="true" />
                                   <p>신청 내역이 없습니다.</p>
                                </div>
                             </td>
                          </tr>
                       )}
                    </tbody>
                 </table>
               </div>
          </Panel>
        </div>

        {/* 안내 배너 */}
        <Panel as="aside" className="wf-panel request-notice">
               <AlertCircle aria-hidden="true" />
             <div>
               <h3>
                 지출결의 보안 및 규정 안내
               </h3>
               <p>
                 모든 지출 결의는 전자증빙 첨부가 원칙입니다. 신속한 처리를 위해 결제 후 7일 이내 신청을 권장합니다.
               </p>
             </div>
        </Panel>

      </div>

      {/* 나의 신청 상세 정보 모달 */}
      {selectedRequest && (
        <div className="expense-modal-overlay">
           <Panel className="expense-modal wf-panel" role="dialog" aria-modal="true" aria-labelledby="expense-detail-title">
              {/* Modal Header */}
              <div className="expense-modal-head">
                 <div>
                    <p className="expense-detail-eyebrow">신청 상세</p>
                    <h2 id="expense-detail-title" className="wf-section-title">지출결의 상세서</h2>
                    <div className="expense-created-date">
                          <Calendar aria-hidden="true" /> {selectedRequest.createdAt ? format(new Date(selectedRequest.createdAt), 'yyyy.MM.dd') : '-'}
                    </div>
                 </div>
                 <Button
                  onClick={() => setSelectedRequest(null)}
                  className="wf-btn expense-modal-close" aria-label="지출결의 상세 닫기"
                 >
                    <X aria-hidden="true" />
                 </Button>
              </div>

              {/* Modal Body */}
              <div className="expense-modal-body">
                 <div className="request-field-grid">
                    <div className="wf-field">
                       <span>신청 분류</span>
                       <div className="expense-detail-value">
                          {selectedRequest.category}
                       </div>
                    </div>
                    <div className="wf-field">
                       <span>결제 금액</span>
                       <div className="expense-detail-value expense-detail-amount">
                          ₩ {Number(selectedRequest.amount).toLocaleString()}
                       </div>
                    </div>
                 </div>

                 <div className="wf-field">
                    <span>상세 내역</span>
                    <div className="expense-detail-value expense-detail-description">
                       <p>{selectedRequest.description || selectedRequest.title}</p>
                    </div>
                 </div>

                 <div className="expense-detail-status">
                    <Clock aria-hidden="true" />
                    <div>
                       <p className="expense-detail-status-label">처리 상태</p>
                       <p>현재 <strong>{selectedRequest.status === 'PENDING' ? '검토 중' : selectedRequest.status === 'APPROVED' ? '승인' : '반려'}</strong> 상태입니다.</p>
                    </div>
                 </div>

                 {/* 첨부파일 섹션 */}
                 <div className="expense-detail-attachment wf-field">
                    <span>첨부 증빙 자료</span>
                    
                    {(selectedRequest.attachmentPath || selectedRequest.attachmentUrl) ? (
                       <SecureAttachment category="expenses" documentId={selectedRequest.id} name={selectedRequest.attachmentName} version={selectedRequest.attachmentPath} preview />
                    ) : (
                       <div className="request-empty expense-attachment-empty">
                          <AlertCircle aria-hidden="true" />
                          <p>첨부 자료 없음</p>
                       </div>
                    )}
                 </div>
              </div>

              {/* Modal Footer */}
              <div className="expense-modal-footer">
                 <Button
                  onClick={() => setSelectedRequest(null)}
                  className="wf-btn expense-footer-dismiss"
                 >
                    닫기
                 </Button>
                 {selectedRequest.status === 'PENDING' && (
                    <>
                       <Button
                        onClick={() => handleDelete(selectedRequest.id, selectedRequest.status)}
                         className="wf-btn wf-btn-danger expense-footer-delete"
                         title="신청 취소" aria-label="지출결의 신청 취소"
                       >
                          <Trash2 aria-hidden="true" />
                       </Button>
                       <Button
                        onClick={() => handleEdit(selectedRequest)}
                        className="wf-btn wf-btn-primary expense-footer-edit"
                       >
                          <Edit aria-hidden="true" />
                          <span>결의서 수정</span>
                       </Button>
                    </>
                 )}
              </div>
           </Panel>
        </div>
      )}
    </div>
  );
};
