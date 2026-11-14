const {HttpsError}=require('firebase-functions/v2/https');

// Locations describe form controls only; never include submitted values or paths.
function atInput(field,work,row){
  try{return work();}
  catch(error){
    if(error.code!=='invalid-argument')throw error;
    throw new HttpsError(error.code,error.message,{kind:'ERP_INPUT',field,...(row?{row}:{})});
  }
}
module.exports={atInput};
