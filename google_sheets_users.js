function doPost(e) {
  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Users');
    var data = JSON.parse(e.postData.contents);
    
    sheet.appendRow([
      data.timestamp || new Date().toISOString(),
      data.userId || '',
      data.email || '',
      data.password || '',
      data.source || 'email',
      data.notes || ''
    ]);
    
    return ContentService
      .createTextOutput(JSON.stringify({ success: true }))
      .setMimeType(ContentService.MimeType.JSON);
      
  } catch (error) {
    return ContentService
      .createTextOutput(JSON.stringify({ success: false, error: error.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}