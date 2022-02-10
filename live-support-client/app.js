Weavy.defaults.url = "https://localhost:44323/";
var weavy;

$(document).ready(() => {
    //click handlers
    $(document).on("click", "#chat-form button", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if(!$("#chat-issue").val().length){
            alert("Please explain the problem you are experiencing");
        }
        else if(!$("#customer-email").val().length){
            alert("Please input your email");
        } else {
            var userId = $("#customer-email").val();
            initWeavy(userId.split("@")[0]);
            
            var data = {Name: $("#chat-issue").val()};
            var app = weavy.space("support").app("support");
            weavy.ajax("/api/support-chat", data, "POST")
            .then(convo => {
                $("#agent-view").prop("disabled", true);
                if(convo == null){
                    alert("Sorry, no customer service agents are online. Please try again later")
                } else{
                    $("#chat-form").addClass("d-none");
                    $("#chat-issue").val("");
                    $("#customer-email").val("");
                    weavy.init()
                    app.open(`e/messenger/${convo.id}`);
                }
            })
            .catch(err => {
                console.warn(err)
                alert("Sorry, no customer service agents are online. Please try again later")
                return false;
            });
        }

    });
    $(document).on("click", "#customer-view", function() {
        if($("#agent-view").hasClass("active")){
            var app = weavy.space("support").app("support");
            app.remove();
            $("#agent-view").removeClass("active");
            $("#customer-view").addClass("active");
            $("#weavy-chat").addClass("customer").removeClass("border");
            $("#chat-form").removeClass("d-none");
        }
    });
    $(document).on("click", "#agent-view", function() {
        $("#customer-view").prop("disabled", true);
        if($("#customer-view").hasClass("active")){
            if(weavy){
                var app = weavy.space("support").app("support");
                if(app){
                    app.remove();
                }
            }
            initWeavy("Agent1");
            $("#customer-view").removeClass("active");
            $("#agent-view").addClass("active");
            $("#weavy-chat").removeClass("customer").removeClass("border");
            $("#chat-form").addClass("d-none");
        }
    });
});

function initWeavy(userId){
    // Header
    var oHeader = { alg: 'HS256', typ: 'JWT' };
    // Payload
    var oPayload = {};
    var tNow = KJUR.jws.IntDate.get('now');
    var tEnd = KJUR.jws.IntDate.get('now + 1day');
    oPayload.iss = "clientid";
    oPayload.sub = userId;
    oPayload.exp = tEnd;
    oPayload.name = userId;
    
    // Sign JWT
    var sHeader = JSON.stringify(oHeader);
    var sPayload = JSON.stringify(oPayload);
    var sJWT = KJUR.jws.JWS.sign("HS256", sHeader, sPayload, "clientsecret");
    weavy = new Weavy({
        logging: false,
        init: false,
        jwt: sJWT
    });
    weavy.space({key:"support"}).app({type: "messenger", key:"support", container: "#weavy-chat", open:true});
    weavy.authentication.whenAuthorized().then(() => {
        weavy.init().then(() => {
            $("#weavy-chat").addClass("border");
        });
    });
    weavy.on("create-root", function (e, createRoot) {
        // Disable loading transitions
        weavy.plugins.theme.addCss(createRoot.root, ".weavy-panel, .weavy-panel-frame { transition: none !important; }");
    });
    weavy.on("message", function(e,data){
        if(data.name === "feedback-sent"){
            var app = weavy.space("support").app("support");
            if(app){
                app.remove().then(()=>{
                    $("#weavy-chat").removeClass("border");
                    $("#chat-form").removeClass("d-none");
                    alert("Thank you, your chat is now closed. You can submit another issue.")
                });
            }
            weavy = null;
        }

    });
}
    