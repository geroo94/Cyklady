## BidRules: reguły licytacji wspólne dla serwera i interfejsu licytacji.
##
## Te same funkcje sprawdzają ofiarę na serwerze (GameStateManager.apply_bid)
## i u klienta, zanim BiddingBoardUI wyśle RPC. Działają na pełnym stanie
## albo na projekcji gracza. Projekcja ukrywa tylko złoto rywali, a do oceny
## ofiary wystarczy złoto i kapłani samego licytującego.
##
## Zasady:
##  - bóg z toru ofiar w tym cyklu: ofiara musi przebić obecną (co najmniej o 1 JZ);
##  - Apollo jest darmowy i przyjmuje wielu graczy (miejsca 1, 2, 3…);
##  - każdy kapłan obniża koszt ofiary o 1 JZ, ale zapłacić trzeba co najmniej 1 JZ;
##  - przebity gracz licytuje od razu, ale nie u boga, u którego go przebito.
class_name BidRules
extends RefCounted

const APOLLO := "APOLLO"
const MAX_BID := 99


## Na kogo czeka licytacja: przebity gracz ma pierwszeństwo, potem kolejka.
static func bidder_of(state: Dictionary) -> String:
	if state.get("phase", "") != "BIDDING":
		return ""
	var bidding: Dictionary = state["bidding"]
	if bidding["displaced"] != "":
		return String(bidding["displaced"])
	var queue: Array = bidding["queue"]
	return "" if queue.is_empty() else String(queue[0])


## Koszt ofiary: kwota minus kapłani, ale zawsze co najmniej 1 JZ.
static func offering_cost(amount: int, priests: int) -> int:
	return maxi(1, amount - priests)


## Pole boga na torze ofiar w tym cyklu ({ god, holder, amount }) albo pusty słownik.
static func god_slot(state: Dictionary, god_id: String) -> Dictionary:
	for slot: Dictionary in state.get("gods", []):
		if slot["god"] == god_id:
			return slot
	return {}


## Najniższa kwota, która przebija obecną ofiarę u boga.
static func min_bid(state: Dictionary, god_id: String) -> int:
	return int(god_slot(state, god_id).get("amount", 0)) + 1


## Najwyższa ofiara, na którą stać gracza (kapłani obniżają koszt). 0: nie stać go na żadną.
static func max_affordable_bid(state: Dictionary, player_id: String) -> int:
	var player: Dictionary = state["players"][player_id]
	var gold := int(player["gold"])
	if gold < 1:
		return 0
	return mini(MAX_BID, gold + int(player["priests"]))


## Powód odrzucenia ofiary (ten sam kod co w odpowiedzi serwera) albo pusty napis.
## Apollo (`god_id == APOLLO`) jest darmowy: wystarczy, że licytacja czeka na tego gracza.
static func bid_error(state: Dictionary, player_id: String, god_id: String, amount: int) -> String:
	if state.get("phase", "") != "BIDDING":
		return "NOT_BIDDING"
	if player_id != bidder_of(state):
		return "NOT_YOUR_TURN"
	if god_id == APOLLO:
		return ""
	var slot := god_slot(state, god_id)
	if slot.is_empty():
		return "UNKNOWN_GOD"
	var bidding: Dictionary = state["bidding"]
	if bidding["displaced"] == player_id and bidding["forbidden"] == god_id:
		return "FORBIDDEN_GOD"
	if slot["holder"] == player_id:
		return "OWN_OFFERING"
	if amount < 1 or amount > MAX_BID:
		return "INVALID_AMOUNT"
	if amount <= int(slot["amount"]):
		return "BID_TOO_LOW"
	var player: Dictionary = state["players"][player_id]
	if offering_cost(amount, int(player["priests"])) > int(player["gold"]):
		return "CANNOT_AFFORD"
	return ""
