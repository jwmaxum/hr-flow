import {test} from 'node:test';
import assert from 'node:assert/strict';
import {erpStartActions} from '../src/utils/erpStart.ts';
import {erpAccessOf} from '../src/utils/erpAccess.ts';
import {erpMenus,erpRoute,erpPath,erpDefaultView,erpTasks} from '../src/utils/erpNavigation.ts';

test('five daily menus retain all existing work in permission-aware groups',()=>{
  assert.deepEqual(erpMenus.filter(m=>m.id!=='admin').map(m=>m.label),['대시보드','품목·재고','입고','판매·출고','미수금·수금']);
  for(const menu of erpMenus)for(const task of erpTasks[menu.id])for(const access of ['ADMIN','MANAGER','BOTH','INBOUND','OUTBOUND','VIEW','NONE']){
    const route=erpRoute(erpPath(task.view,menu.id).split('?')[1],access);
    assert.equal(route.denied,!task.allow(access));assert.equal(route.menu,menu.id);assert.equal(route.view,task.view);
  }
  assert.equal(erpDefaultView('inbound','OUTBOUND'),'report');assert.equal(erpDefaultView('sales','INBOUND'),'report');
  assert.equal(erpDefaultView('dashboard','MANAGER'),'today');assert.equal(erpDefaultView('receivables','VIEW'),undefined);
});
test('legacy notification links, source documents and forbidden deep links retain their scope',()=>{
  assert.equal(erpRoute('?panel=approvals','BOTH').view,'approvals');assert.equal(erpRoute('?panel=closing','MANAGER').view,'closing');
  const path=erpPath('documents','sales','출고 & 001');assert.equal(erpRoute(path.split('?')[1],'ADMIN').source,'출고 & 001');
  for(const view of ['finance','dashboard','shipments','documents','import','opening','access','close','history'])assert.equal(erpRoute(erpPath(view).split('?')[1],'MANAGER').denied,true,view);
  assert.equal(erpRoute(erpPath('documents','sales','','draft-id').split('?')[1],'ADMIN').draft,'draft-id');
  assert.equal(erpRoute('?view=unknown','ADMIN').denied,true);assert.equal(erpRoute('?menu=stock&view=finance','ADMIN').denied,true);
  assert.deepEqual(erpRoute('','VIEW'),{menu:'dashboard',view:'today',denied:false,source:'',draft:''});
});
test('ERP manager requires the current active SUB_ADMIN role and never promotes HR privileges',()=>{
  assert.equal(erpAccessOf({role:'SUB_ADMIN',erpAccess:'MANAGER',status:'ACTIVE'}),'MANAGER');
  for(const role of ['MEMBER','SUPER_ADMIN','SYSTEM_ADMIN',undefined])assert.equal(erpAccessOf({role,erpAccess:'MANAGER'}),'NONE');
  assert.equal(erpAccessOf({role:'SUB_ADMIN',erpAccess:'MANAGER',status:'RESIGNED'}),'NONE');
  assert.equal(erpAccessOf({role:'ADMIN',erpAccess:'NONE'}),'ADMIN');assert.equal(erpAccessOf({role:'MEMBER',erpAccess:'BOTH'}),'BOTH');
});


test('role-specific start actions stay within permissions while explicit deep links are preserved',()=>{
  const primary={ADMIN:'inbound',MANAGER:'inbound',BOTH:'inbound',INBOUND:'inbound',OUTBOUND:'outbound',VIEW:'items'};
  for(const [role,view]of Object.entries(primary)){
    assert.equal(erpRoute('',role).view,'today');assert.equal(erpRoute('',role).denied,false);
    assert.equal(erpStartActions(role)[0].view,view);
    for(const task of erpStartActions(role))assert.equal(erpRoute(erpPath(task.view).split('?')[1],role).denied,false);
  }
  assert.deepEqual(erpStartActions('NONE'),[]);assert.equal(erpRoute('','NONE').denied,true);
  assert.equal(erpRoute('?menu=unknown','ADMIN').denied,true);
  assert.equal(erpRoute('?menu=inbound','INBOUND').view,'inbound');
  assert.equal(erpRoute('?menu=stock&view=items','OUTBOUND').view,'items');
});
