'use strict';
// Model-provided confirmation strings are never proof of human consent.
async function requestBindingApproval(questions, exec, action, detail) {
  if (!exec?.agent || !exec?.signal || exec.signal.aborted || !questions?.ask)
    throw new Error('User binding approval unavailable; operation denied');
  const id = 'rw-binding-approval';
  const response = await questions.ask({
    questions:[{id,header:'远程项目操作审批',question:`允许本次 ${action} 操作吗？`,
      detail:String(detail).slice(0,1024),options:[
        {label:'批准本次操作',description:'仅同意当前请求'},
        {label:'拒绝',description:'不执行本次操作'}]}],
    agent:exec.agent,signal:exec.signal,
  });
  const matches = response?.answers?.filter(x=>x.id===id) || [];
  if (exec.signal.aborted || matches.length!==1 || matches[0].selected?.length!==1 ||
      matches[0].selected[0]!=='批准本次操作' || matches[0].custom!==undefined)
    throw new Error('Remote project operation declined or aborted');
}
module.exports = { requestBindingApproval };
