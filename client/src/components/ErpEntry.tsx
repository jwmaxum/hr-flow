import { NavLink } from 'react-router-dom';
import { Boxes } from 'lucide-react';

export function ErpEntry({ onNavigate }: { onNavigate?: () => void }) {
  return <NavLink to="/erp" className="erp-entry" onClick={onNavigate} aria-label="ERP 재고관리">
    <Boxes size={16} aria-hidden="true" /><span>ERP</span>
  </NavLink>;
}
