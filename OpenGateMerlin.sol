// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title  OpenGate Heroes — Merlin (FREE MINT)
 * @notice Безкоштовний NFT для OpenGate. Мінт без оплати і без ліміту.
 *
 * Деплой через Remix (remix.ethereum.org):
 *   1. Compiler 0.8.20+, Deploy & Run → Injected Provider (MetaMask на мережі LitVM)
 *   2. Constructor: _imageURL = https://opengate.bond/merlin.jpg
 *   3. Deploy → скопіюй адресу контракту
 *
 * Сумісний з:
 *   - NFT Marketplace OpenGate (transferFrom, isApprovedForAll, tokenURI, ownerOf)
 *   - NFT-аватарками (tokenOfOwnerByIndex, balanceOf, tokenURI)
 *   - Метадані on-chain (base64 JSON) — жодного IPFS не треба
 */

contract OpenGateMerlin {

    string public name   = "OpenGate Heroes: Merlin";
    string public symbol = "MERLIN";
    string public imageURL;
    string public constant DESCRIPTION =
        "The legendary archmage of ancient times. Master of time, space, and transformation. OpenGate Heroes free collection.";

    address public owner;
    uint256 public totalSupply;
    bool    public mintOpen = true;

    // ERC721 core
    mapping(uint256 => address) private _owners;
    mapping(address => uint256) private _balances;
    mapping(uint256 => address) private _tokenApprovals;
    mapping(address => mapping(address => bool)) private _operatorApprovals;

    // Enumeration per owner (для сканера NFT-аватарок)
    mapping(address => mapping(uint256 => uint256)) private _ownedTokens;
    mapping(uint256 => uint256) private _ownedTokensIndex;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner_, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner_, address indexed operator, bool approved);

    modifier onlyOwner() { require(msg.sender == owner, "Not owner"); _; }

    constructor(string memory _imageURL) {
        owner = msg.sender;
        imageURL = _imageURL;
    }

    // ── FREE MINT ────────────────────────────────────────────────────────────

    function mint(uint256 qty) external {
        require(mintOpen, "Mint closed");
        require(qty > 0 && qty <= 20, "1-20 per tx");
        for (uint256 i = 0; i < qty; i++) {
            uint256 id = ++totalSupply;
            _owners[id] = msg.sender;
            _addToOwner(msg.sender, id);
            emit Transfer(address(0), msg.sender, id);
        }
    }

    // ── ADMIN ────────────────────────────────────────────────────────────────

    function setImage(string calldata _url) external onlyOwner { imageURL = _url; }
    function setMintOpen(bool _open) external onlyOwner { mintOpen = _open; }
    function transferOwnership(address w) external onlyOwner { owner = w; }

    // ── ERC721 VIEWS ─────────────────────────────────────────────────────────

    function balanceOf(address a) public view returns (uint256) {
        require(a != address(0), "Zero address");
        return _balances[a];
    }

    function ownerOf(uint256 id) public view returns (address) {
        address o = _owners[id];
        require(o != address(0), "Nonexistent token");
        return o;
    }

    function tokenOfOwnerByIndex(address a, uint256 index) external view returns (uint256) {
        require(index < _balances[a], "Index out of bounds");
        return _ownedTokens[a][index];
    }

    function getApproved(uint256 id) public view returns (address) {
        require(_owners[id] != address(0), "Nonexistent token");
        return _tokenApprovals[id];
    }

    function isApprovedForAll(address o, address op) public view returns (bool) {
        return _operatorApprovals[o][op];
    }

    function supportsInterface(bytes4 iid) external pure returns (bool) {
        return iid == 0x80ac58cd  // ERC721
            || iid == 0x5b5e139f  // ERC721Metadata
            || iid == 0x01ffc9a7; // ERC165
    }

    // ── METADATA (on-chain base64 JSON) ─────────────────────────────────────

    function tokenURI(uint256 id) external view returns (string memory) {
        require(_owners[id] != address(0), "Nonexistent token");
        bytes memory json = abi.encodePacked(
            '{"name":"Merlin #', _toString(id),
            '","description":"', DESCRIPTION,
            '","image":"', imageURL, '"}'
        );
        return string(abi.encodePacked("data:application/json;base64,", _base64(json)));
    }

    // ── ERC721 TRANSFERS (потрібно для продажу на маркетплейсі) ─────────────

    function approve(address to, uint256 id) external {
        address o = ownerOf(id);
        require(msg.sender == o || _operatorApprovals[o][msg.sender], "Not authorized");
        _tokenApprovals[id] = to;
        emit Approval(o, to, id);
    }

    function setApprovalForAll(address op, bool approved) external {
        _operatorApprovals[msg.sender][op] = approved;
        emit ApprovalForAll(msg.sender, op, approved);
    }

    function transferFrom(address from, address to, uint256 id) public {
        address o = ownerOf(id);
        require(o == from, "Wrong from");
        require(to != address(0), "Zero to");
        require(
            msg.sender == o ||
            msg.sender == _tokenApprovals[id] ||
            _operatorApprovals[o][msg.sender],
            "Not authorized"
        );
        delete _tokenApprovals[id];
        _removeFromOwner(from, id);
        _addToOwner(to, id);
        _owners[id] = to;
        emit Transfer(from, to, id);
    }

    function safeTransferFrom(address from, address to, uint256 id) external {
        safeTransferFrom(from, to, id, "");
    }

    function safeTransferFrom(address from, address to, uint256 id, bytes memory data) public {
        transferFrom(from, to, id);
        if (to.code.length > 0) {
            (bool ok, bytes memory ret) = to.call(
                abi.encodeWithSelector(0x150b7a02, msg.sender, from, id, data)
            );
            require(ok && ret.length >= 32 && bytes4(ret) == 0x150b7a02, "Unsafe receiver");
        }
    }

    // ── INTERNAL ─────────────────────────────────────────────────────────────

    function _addToOwner(address to, uint256 id) internal {
        uint256 idx = _balances[to];
        _ownedTokens[to][idx] = id;
        _ownedTokensIndex[id] = idx;
        _balances[to]++;
    }

    function _removeFromOwner(address from, uint256 id) internal {
        uint256 last = _balances[from] - 1;
        uint256 idx  = _ownedTokensIndex[id];
        if (idx != last) {
            uint256 lastId = _ownedTokens[from][last];
            _ownedTokens[from][idx] = lastId;
            _ownedTokensIndex[lastId] = idx;
        }
        delete _ownedTokens[from][last];
        delete _ownedTokensIndex[id];
        _balances[from]--;
    }

    function _toString(uint256 v) internal pure returns (string memory) {
        if (v == 0) return "0";
        uint256 t = v; uint256 d;
        while (t != 0) { d++; t /= 10; }
        bytes memory b = new bytes(d);
        while (v != 0) { d--; b[d] = bytes1(uint8(48 + v % 10)); v /= 10; }
        return string(b);
    }

    function _base64(bytes memory data) internal pure returns (string memory) {
        string memory table = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        if (data.length == 0) return "";
        string memory result = new string(4 * ((data.length + 2) / 3));
        assembly {
            let tablePtr := add(table, 1)
            let resultPtr := add(result, 32)
            for { let dataPtr := data let endPtr := add(data, mload(data)) }
                lt(dataPtr, endPtr) {}
            {
                dataPtr := add(dataPtr, 3)
                let input := mload(dataPtr)
                mstore8(resultPtr, mload(add(tablePtr, and(shr(18, input), 0x3F)))) resultPtr := add(resultPtr, 1)
                mstore8(resultPtr, mload(add(tablePtr, and(shr(12, input), 0x3F)))) resultPtr := add(resultPtr, 1)
                mstore8(resultPtr, mload(add(tablePtr, and(shr(6, input), 0x3F))))  resultPtr := add(resultPtr, 1)
                mstore8(resultPtr, mload(add(tablePtr, and(input, 0x3F))))          resultPtr := add(resultPtr, 1)
            }
            switch mod(mload(data), 3)
            case 1 { mstore(sub(resultPtr, 2), shl(240, 0x3d3d)) }
            case 2 { mstore(sub(resultPtr, 1), shl(248, 0x3d)) }
        }
        return result;
    }
}
